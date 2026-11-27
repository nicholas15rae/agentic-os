#!/usr/bin/env bash
# =============================================================================================
# Agentic OS - cloud droplet bootstrap.
# Target: DigitalOcean ubuntu-s-1vcpu-2gb-70gb-intel-tor1 - Ubuntu 24.04 LTS (noble), 1 vCPU,
# 2 GB RAM, 70 GB NVMe. Also runs on 22.04 (jammy): nothing here depends on a release codename.
#
# Idempotent: safe to re-run; every step checks what is already there.
# ASCII-only on purpose (Windows PowerShell 5.1 mangles non-ASCII when piping to ssh).
#
# What it installs (and nothing else):
#   log caps (journald 100 MB, rsyslog off) - bloat removal (snapd/lxd) - swap (1 GB, guarded)
#   ufw + SSH hardening - earlyoom + OOM protection for sshd / droplet-agent / netbird
#   NetBird - llama.cpp server b12463 - ONE model: Qwen2.5-0.5B-Instruct IQ4_XS (349 MB)
#   optional: n8n in Docker (ENABLE_N8N=1, off by default)
#
# HARD GUARDRAILS (non-negotiable - the old droplet was bricked by a full disk + OOM):
#   * every download/install runs preflight(): prints df -h / free -m and ABORTS if
#       - free disk would drop below DISK_FLOOR_MB (2048 MB), or
#       - total used disk would reach DISK_BUDGET_MB (6.5 GB - a deliberately lean target even
#         on the 70 GB disk, so a runaway download or log is caught long before the disk fills), or
#       - MemAvailable would drop below RAM_FLOOR_MB (300 MB)
#   * old / partial model files are deleted BEFORE a new model is downloaded
#   * journald capped (100 MB, keeps 2 GB free), rsyslog off, Docker json logs capped (3 x 10 MB)
#   * swap is only created if >= 3.5 GB stays free afterwards
#   * sshd, droplet-agent (web console) and netbird are shielded from the OOM killer; earlyoom
#     kills llama-server first; llama-server has a hard MemoryMax and a restart limit, so it can
#     never OOM-loop
#
# Usage (from Windows PowerShell on the desktop; NEW_IP = the droplet's public IP):
#   1) upload:  Get-Content -Raw "G:\agentic os\scripts\droplet-bootstrap.sh" | ssh root@NEW_IP "sed '1s/^\xEF\xBB\xBF//' | tr -d '\r' > /root/droplet-bootstrap.sh && chmod 700 /root/droplet-bootstrap.sh"
#      (sed drops the UTF-8 BOM some PowerShell setups add; tr drops CRLF)
#   2) run:     ssh -t root@NEW_IP "bash /root/droplet-bootstrap.sh"
#   Run it yourself: it asks for the NetBird setup key (a credential) with hidden input.
#      It asks for the NetBird setup key (hidden input) the first time NetBird isn't connected.
# =============================================================================================
set -Eeuo pipefail

# ---- pinned versions (verified 2026-11-24) ---------------------------------------------------
LLAMA_TAG=b12463
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
LLAMA_SHA256=0a8c39f7b8e765d84f7bca57883309b33c6b57fd79b016b43f502a8ef2941cff
LLAMA_DL_MB=24

MODEL_FILE=Qwen2.5-0.5B-Instruct-IQ4_XS.gguf
MODEL_URL="https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/${MODEL_FILE}"
MODEL_SHA256=df178ccd68e24ce0c74f957765c00e8f5eec5c51216a1acd4444202e58df6cc1
MODEL_BYTES=349402688
MODEL_ALIAS=qwen2.5-0.5b-instruct
MODEL_CTX=2048

# ---- limits ----------------------------------------------------------------------------------
DISK_FLOOR_MB=2048        # never let free disk drop below 2 GB
DISK_BUDGET_MB=6656       # total used disk must stay under 6.5 GB (lean target; disk is 70 GB)
SWAP_MB=1024
SWAP_HEADROOM_MB=3584     # only create swap if >= 3.5 GB stays free afterwards
RAM_FLOOR_MB=300          # MemAvailable must stay above this after a service starts
LLM_EXTRA_MB=160          # KV cache (~24 MB at -c 2048) + compute buffers + server overhead

BASE=/opt/llm
UNIT=agentic-llm
PORT=8000
ENABLE_N8N="${ENABLE_N8N:-0}"
N8N_IMAGE="${N8N_IMAGE:-n8nio/n8n:latest}"
N8N_DISK_MB=2600          # docker.io (~400 MB) + n8n image (~1.8 GB measured) + data
N8N_RAM_MB=512
SUMMARY=/var/log/agentic-bootstrap.log

# ---- helpers ---------------------------------------------------------------------------------
STEP="start"
log()  { printf '%s [%s] %s\n' "$(date +%H:%M:%S)" "$STEP" "$*" | tee -a "$SUMMARY"; }
die()  { log "ABORT: $*"; log "Nothing after this point was changed. Fix the cause and re-run (the script is idempotent)."; exit 1; }
trap 'die "command failed on line $LINENO: $BASH_COMMAND"' ERR
step() { STEP="$1"; log "== $1"; }
disk_avail_mb() { df -Pm / | awk 'NR==2 {print $4}'; }
disk_used_mb()  { df -Pm / | awk 'NR==2 {print $3}'; }
mem_avail_mb()  { awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo; }
mem_total_mb()  { awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo; }

# preflight <what> <disk_mb_to_write> <ram_mb_to_use>
preflight() {
  local what="$1" need_disk="$2" need_ram="$3"
  local avail used mem
  avail=$(disk_avail_mb); used=$(disk_used_mb); mem=$(mem_avail_mb)
  log "preflight for $what: needs ${need_disk} MB disk, ${need_ram} MB RAM"
  df -h / | tee -a "$SUMMARY"
  free -m | tee -a "$SUMMARY"
  if (( avail - need_disk < DISK_FLOOR_MB )); then
    die "$what would leave $(( avail - need_disk )) MB free disk (< ${DISK_FLOOR_MB} MB floor)"
  fi
  if (( used + need_disk >= DISK_BUDGET_MB )); then
    die "$what would bring used disk to $(( used + need_disk )) MB (budget ${DISK_BUDGET_MB} MB)"
  fi
  if (( mem - need_ram < RAM_FLOOR_MB )); then
    die "$what would leave $(( mem - need_ram )) MB RAM available (< ${RAM_FLOOR_MB} MB floor)"
  fi
  log "preflight OK: disk free after ~$(( avail - need_disk )) MB, used after ~$(( used + need_disk )) MB, RAM avail after ~$(( mem - need_ram )) MB"
}

sha_ok() { [ -s "$1" ] && echo "$2  $1" | sha256sum -c --status; }

# A fresh droplet runs unattended-upgrades on first boot and holds the apt/dpkg lock.
wait_apt() {
  local n=0
  while pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null || pgrep -f 'bin/unattended-upgrade( |$)' >/dev/null; do
    (( n == 0 )) && log "waiting for another apt/dpkg run (first-boot updates) to finish..."
    n=$(( n + 1 )); (( n < 120 )) || die "apt is still busy after 10 minutes"
    sleep 5
  done
}
APT="apt-get -o DPkg::Lock::Timeout=300"

# =============================================================================================
step "0. sanity"
touch "$SUMMARY"; chmod 600 "$SUMMARY"
[ "$(id -u)" -eq 0 ] || die "run as root"
. /etc/os-release
case "${VERSION_ID:-}" in
  24.04|22.04) log "OS: ${PRETTY_NAME}" ;;
  *) die "tested for Ubuntu 24.04 (noble) and 22.04 only; this is ${PRETTY_NAME:-unknown}" ;;
esac
log "host $(hostname), RAM $(mem_total_mb) MB, disk used $(disk_used_mb) MB / free $(disk_avail_mb) MB"
(( $(mem_total_mb) >= 1800 )) || die "this plan needs the 2 GB droplet; found $(mem_total_mb) MB RAM"
export DEBIAN_FRONTEND=noninteractive
# A brand-new droplet is still running cloud-init (first-boot setup, package installs) for a few
# minutes. Don't race it: wait up to 10 minutes for it to finish.
if command -v cloud-init >/dev/null 2>&1; then
  if ! cloud-init status 2>/dev/null | grep -qE 'status: (done|disabled)'; then
    log "waiting for cloud-init first-boot setup to finish (up to 10 min)..."
    timeout 600 cloud-init status --wait >/dev/null 2>&1 || true
  fi
  log "cloud-init: $(cloud-init status 2>/dev/null | head -1)"
fi

# =============================================================================================
step "1. log caps first (logs can never fill the disk)"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/10-agentic-caps.conf <<'EOF'
[Journal]
SystemMaxUse=100M
SystemKeepFree=2G
SystemMaxFileSize=20M
RuntimeMaxUse=32M
MaxRetentionSec=14day
EOF
systemctl restart systemd-journald
journalctl --vacuum-size=100M >/dev/null 2>&1 || true
# journald already keeps everything; rsyslog only duplicates it into /var/log/syslog.
if systemctl is-enabled rsyslog >/dev/null 2>&1; then
  systemctl disable --now rsyslog >/dev/null 2>&1 || true
  : > /var/log/syslog 2>/dev/null || true
  log "rsyslog disabled (journald is the only log, capped at 100 MB)"
fi

# =============================================================================================
step "2. remove bloat (snapd/lxd, apt cache)"
if command -v snap >/dev/null 2>&1; then
  snap remove --purge lxd >/dev/null 2>&1 || true
  wait_apt; $APT purge -y -qq snapd >/dev/null 2>&1 || true
  rm -rf /snap /var/snap /var/lib/snapd /root/snap
  log "snapd and lxd removed"
fi
wait_apt; $APT autoremove -y -qq >/dev/null 2>&1 || true
apt-get clean
log "disk used now $(disk_used_mb) MB, free $(disk_avail_mb) MB"

# =============================================================================================
step "3. swap (guarded)"
if swapon --show=NAME --noheadings | grep -q .; then
  log "swap already on: $(swapon --show --noheadings | awk '{print $1" "$3}' | tr '\n' ' ')"
else
  if (( $(disk_avail_mb) - SWAP_MB >= SWAP_HEADROOM_MB )); then
    preflight "swapfile" "$SWAP_MB" 0
    fallocate -l "${SWAP_MB}M" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    log "swap ${SWAP_MB} MB on"
  else
    log "SKIPPED swap: only $(disk_avail_mb) MB free (needs ${SWAP_MB} + ${SWAP_HEADROOM_MB} MB headroom)"
  fi
fi
cat > /etc/sysctl.d/90-agentic.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl -q --system

# =============================================================================================
step "4. packages"
preflight "apt packages" 60 0
wait_apt; $APT update -qq
# libgomp1: OpenMP runtime the prebuilt llama.cpp CPU build links against (not always on noble).
$APT install -y -qq --no-install-recommends ufw curl ca-certificates gnupg earlyoom libgomp1 >/dev/null
apt-get clean

# =============================================================================================
step "5. OOM shielding (keep SSH and the web console alive no matter what)"
for svc in ssh droplet-agent netbird; do
  if systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q "^${svc}.service"; then
    mkdir -p "/etc/systemd/system/${svc}.service.d"
    printf '[Service]\nOOMScoreAdjust=-900\n' > "/etc/systemd/system/${svc}.service.d/10-oom-shield.conf"
    log "OOM shield on ${svc}"
  fi
done
cat > /etc/default/earlyoom <<'EOF'
# No quotes or spaces inside the regexes: systemd splits $EARLYOOM_ARGS on spaces and keeps quotes literally.
EARLYOOM_ARGS="-m 8 -s 10 -r 3600 --prefer (^|/)(llama-server|node)$ --avoid (^|/)(sshd|droplet-agent|netbird|systemd|init|dockerd|containerd)$"
EOF
systemctl daemon-reload
systemctl enable --now earlyoom >/dev/null 2>&1
systemctl restart earlyoom

# =============================================================================================
step "6. SSH hardening (keys only)"
if [ -s /root/.ssh/authorized_keys ] && ssh-keygen -lf /root/.ssh/authorized_keys >/dev/null 2>&1; then
  log "authorized keys (compare with your PC: ssh-keygen -lf ~/.ssh/id_ed25519.pub):"
  ssh-keygen -lf /root/.ssh/authorized_keys | awk '{print "  " $1 " " $2 " " $NF}' | tee -a "$SUMMARY"
  # sshd uses the FIRST value it reads; 10- sorts before cloud-init's 50-cloud-init.conf.
  cat > /etc/ssh/sshd_config.d/10-agentic-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
EOF
  # Ubuntu 24.04 socket-activates sshd (ssh.socket); reload when running, else the next start reads it.
  # A restart never drops open sessions (they live in their own sshd processes).
  mkdir -p /run/sshd   # sshd -t needs it; under socket activation it may not exist yet
  if sshd -t; then
    if systemctl is-active --quiet ssh; then systemctl reload ssh || systemctl restart ssh; fi
    log "sshd: key-only login (password login off)"
  else rm -f /etc/ssh/sshd_config.d/10-agentic-hardening.conf; die "sshd config test failed; hardening rolled back"; fi
else
  log "SKIPPED SSH hardening: no valid key in /root/.ssh/authorized_keys (would lock you out)"
fi

# =============================================================================================
step "7. firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
log "ufw: deny in, allow OpenSSH (model port is opened on the NetBird interface in step 8)"

# =============================================================================================
step "8. NetBird"
if ! command -v netbird >/dev/null 2>&1; then
  preflight "netbird" 80 60
  curl -fsSL https://pkgs.netbird.io/debian/public.key | gpg --dearmor --yes -o /usr/share/keyrings/netbird-archive-keyring.gpg
  echo 'deb [signed-by=/usr/share/keyrings/netbird-archive-keyring.gpg] https://pkgs.netbird.io/debian stable main' > /etc/apt/sources.list.d/netbird.list
  wait_apt; $APT update -qq
  $APT install -y -qq netbird >/dev/null
  apt-get clean
  netbird service install >/dev/null 2>&1 || true
  netbird service start >/dev/null 2>&1 || true
  mkdir -p /etc/systemd/system/netbird.service.d
  printf '[Service]\nOOMScoreAdjust=-900\n' > /etc/systemd/system/netbird.service.d/10-oom-shield.conf
  systemctl daemon-reload
fi
mesh_ip() { ip -4 -o addr show wt0 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
if [ -z "$(mesh_ip)" ]; then
  KEY="${NETBIRD_SETUP_KEY:-}"
  if [ -z "$KEY" ] && [ -t 0 ]; then read -rsp "NetBird setup key (hidden): " KEY; echo; fi
  [ -n "$KEY" ] || die "NetBird is not connected. Re-run with 'ssh -t' to be asked for the setup key."
  netbird up --setup-key "$KEY" >/dev/null
  unset KEY NETBIRD_SETUP_KEY
  for _ in $(seq 1 30); do [ -n "$(mesh_ip)" ] && break; sleep 2; done
fi
MESH_IP="$(mesh_ip)"
[ -n "$MESH_IP" ] || die "NetBird did not come up (no wt0 address)"
log "NetBird mesh IP: $MESH_IP"
ufw allow in on wt0 to any port "$PORT" proto tcp >/dev/null
ufw allow in on wt0 to any port 22 proto tcp >/dev/null

# =============================================================================================
step "9. llama.cpp server ${LLAMA_TAG}"
if [ "$(cat "$BASE/bin/.tag" 2>/dev/null)" != "$LLAMA_TAG" ]; then
  preflight "llama.cpp ${LLAMA_TAG}" $(( LLAMA_DL_MB * 4 )) 0
  TMP=$(mktemp -d /var/tmp/llama.XXXXXX)
  curl -fsSL --retry 3 -o "$TMP/llama.tgz" "$LLAMA_URL"
  sha_ok "$TMP/llama.tgz" "$LLAMA_SHA256" || { rm -rf "$TMP"; die "llama.cpp tarball sha256 mismatch"; }
  tar -xzf "$TMP/llama.tgz" -C "$TMP"
  SRV=$(find "$TMP" -name llama-server -type f | head -1)
  [ -n "$SRV" ] || { rm -rf "$TMP"; die "llama-server not found in the release"; }
  rm -rf "$BASE/bin"; mkdir -p "$BASE/bin"
  cp "$SRV" "$BASE/bin/"
  find "$(dirname "$SRV")" -maxdepth 1 -name '*.so*' -exec cp -a {} "$BASE/bin/" \;
  chmod 755 "$BASE/bin/llama-server"
  echo "$LLAMA_TAG" > "$BASE/bin/.tag"
  rm -rf "$TMP"
fi
LD_LIBRARY_PATH="$BASE/bin" "$BASE/bin/llama-server" --version 2>&1 | tail -1 | tee -a "$SUMMARY"
log "llama.cpp on disk: $(du -sm "$BASE/bin" | cut -f1) MB"

# =============================================================================================
step "10. model (exactly one GGUF on disk)"
mkdir -p "$BASE/models"
TARGET="$BASE/models/$MODEL_FILE"
# Delete every OTHER model and any partial download BEFORE downloading.
find "$BASE/models" -maxdepth 1 -type f \( -name '*.gguf' -o -name '*.part' \) ! -path "$TARGET" -print -delete | sed 's/^/deleted /' | tee -a "$SUMMARY"
if sha_ok "$TARGET" "$MODEL_SHA256"; then
  log "model already present and verified"
else
  rm -f "$TARGET"
  MODEL_MB=$(( MODEL_BYTES / 1048576 + 1 ))
  preflight "model ${MODEL_FILE}" "$MODEL_MB" $(( MODEL_MB + LLM_EXTRA_MB ))
  curl -fL --retry 3 -o "$TARGET.part" "$MODEL_URL"
  [ "$(stat -c %s "$TARGET.part")" -eq "$MODEL_BYTES" ] || { rm -f "$TARGET.part"; die "model size mismatch"; }
  mv "$TARGET.part" "$TARGET"
  sha_ok "$TARGET" "$MODEL_SHA256" || { rm -f "$TARGET"; die "model sha256 mismatch (deleted)"; }
  log "model downloaded and verified"
fi
log "GGUF files on disk: $(find / -xdev -name '*.gguf' 2>/dev/null | wc -l) (must be 1)"

# =============================================================================================
step "11. API key"
mkdir -p /etc/llm
[ -s /etc/llm/api-key ] || { umask 077; openssl rand -hex 24 > /etc/llm/api-key; }
chmod 600 /etc/llm/api-key

# =============================================================================================
step "12. model service (${UNIT})"
MODEL_MB=$(( MODEL_BYTES / 1048576 + 1 ))
MEM_MAX=$(( MODEL_MB + LLM_EXTRA_MB + 300 ))       # ~800 MB hard ceiling
MEM_HIGH=$(( MEM_MAX - 100 ))
cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=Agentic OS cloud fallback model (${MODEL_ALIAS}, llama.cpp ${LLAMA_TAG})
After=network-online.target netbird.service
Wants=network-online.target
# Never OOM-loop: at most 3 starts in 5 minutes, then stay down until someone looks.
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Environment=LD_LIBRARY_PATH=${BASE}/bin
ExecStart=${BASE}/bin/llama-server -m ${TARGET} --alias ${MODEL_ALIAS} --host ${MESH_IP} --port ${PORT} --api-key-file /etc/llm/api-key -c ${MODEL_CTX} -np 1 -t 1 -tb 1 --jinja --no-webui
Restart=on-failure
RestartSec=10
MemoryHigh=${MEM_HIGH}M
MemoryMax=${MEM_MAX}M
OOMScoreAdjust=800
Nice=5

[Install]
WantedBy=multi-user.target
EOF
# Old unit name from the first droplet, if it ever exists here.
systemctl disable --now llama-qwen >/dev/null 2>&1 || true
rm -f /etc/systemd/system/llama-qwen.service
systemctl daemon-reload
if ! systemctl is-active --quiet "$UNIT"; then preflight "start ${UNIT}" 0 $(( MODEL_MB + LLM_EXTRA_MB )); fi
systemctl enable "$UNIT" >/dev/null 2>&1
systemctl restart "$UNIT"
for i in $(seq 1 60); do
  curl -s -m 3 "http://${MESH_IP}:${PORT}/health" | grep -q '"ok"' && { log "model healthy after $(( i * 2 )) s"; break; }
  sleep 2
done
curl -s -m 3 "http://${MESH_IP}:${PORT}/health" | grep -q '"ok"' || die "model did not become healthy; see: journalctl -u ${UNIT} -n 40"

# =============================================================================================
if [ "$ENABLE_N8N" = "1" ]; then
  step "13. n8n (optional)"
  if ! command -v docker >/dev/null 2>&1; then
    preflight "docker + n8n" "$N8N_DISK_MB" "$N8N_RAM_MB"
    wait_apt; $APT install -y -qq --no-install-recommends docker.io >/dev/null
    apt-get clean
  fi
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
  systemctl restart docker
  if ! docker ps -a --format '{{.Names}}' | grep -qx n8n; then
    preflight "n8n container" 0 "$N8N_RAM_MB"
    docker run -d --name n8n --restart unless-stopped --memory "${N8N_RAM_MB}m" --memory-swap "${N8N_RAM_MB}m" \
      -p "${MESH_IP}:5678:5678" -v n8n_data:/home/node/.n8n "$N8N_IMAGE" >/dev/null
  fi
  docker image prune -f >/dev/null
  ufw allow in on wt0 to any port 5678 proto tcp >/dev/null
fi

# =============================================================================================
step "done"
H="Authorization: Bearer $(cat /etc/llm/api-key)"
log "models endpoint: $(curl -s -m 5 -H "$H" "http://${MESH_IP}:${PORT}/v1/models" 2>/dev/null | head -c 200 || true)"
log "llama-server RSS: $( (ps -o rss= -C llama-server || true) | awk '{s+=$1} END {print int(s/1024)}') MB"
log "disk: used $(disk_used_mb) MB (budget ${DISK_BUDGET_MB}), free $(disk_avail_mb) MB (floor ${DISK_FLOOR_MB})"
(( $(disk_used_mb) < DISK_BUDGET_MB )) || log "WARNING: used disk is over the 6.5 GB budget"
free -m | tee -a "$SUMMARY"
{ du -sm "$BASE" /var/log/journal /swapfile 2>/dev/null || true; } | tee -a "$SUMMARY"
log "NEXT on the desktop: point the droplet provider at http://${MESH_IP}:${PORT}/v1 (model ${MODEL_ALIAS}),"
log "store the key from /etc/llm/api-key in Settings, and add this peer to the NetBird 'droplet' group."
