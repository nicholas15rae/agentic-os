//! ComfyUI workflow templates for the Director (plan §2.5).
//!
//! Each template is an API-format prompt (the JSON ComfyUI's `POST /prompt`
//! takes under `"prompt"`), embedded from `resources/comfy/*.json` with
//! `include_str!` so nothing ships through the bundle config. `fill` parses a
//! template, validates `GenParams` strictly, writes the values into fixed
//! `(node id, input)` slots and re-validates the whole graph against a
//! hand-derived schema of the ComfyUI v0.46.0 core nodes ([`NODE_SPECS`]).
//!
//! Pure and offline: no HTTP, no GPU, no filesystem writes. `comfy.rs` owns the
//! process, the queue and the GPU baton; it calls `list`, `required_models`,
//! `missing_models`, `fill`, `output_node_ids` and `extra_model_paths_yaml`.
//!
//! Notes that matter to callers:
//! * SDXL Turbo runs at `cfg 1.0`. At cfg 1.0 ComfyUI skips the unconditional
//!   pass (`comfy/samplers.py:610`), so the negative prompt has **no effect** on
//!   turbo renders. It is still wired (and stored for provenance) so a future
//!   non-turbo checkpoint can use it. Anything the image must avoid goes into
//!   the positive prompt as a positive description ("blank wall"), never "no X".
//! * SDXL can't spell. `thumbnail-bg` only paints a background with clean
//!   negative space; the title text is overlaid later by media-forge / ffmpeg.
//! * `LoadImage` (nodes.py:1747) only reads ComfyUI's input directory; v0.46 has
//!   no core node that loads an absolute path, and `get_annotated_filepath`
//!   (folder_paths.py:352) rejects anything that resolves outside the base dir.
//!   So `input_image` is a name relative to ComfyUI's input dir (comfy.rs must
//!   launch with `--input-directory G:\ai-hub\comfy\input` and copy the still
//!   there), or `"<subfolder>/<file> [output]"` to reuse an earlier render in
//!   the output dir without copying (folder_paths.py:266 annotation).
//! * `fill` is deterministic: `seed` must be `Some`; the caller picks a random
//!   one and records it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// SDXL Turbo checkpoint file name as ComfyUI lists it under `checkpoints`.
#[cfg_attr(not(test), allow(dead_code))]
pub const SDXL_TURBO_CKPT: &str = "sd_xl_turbo_1.0_fp16.safetensors";
/// Upscaler file name as ComfyUI lists it under `upscale_models`.
#[cfg_attr(not(test), allow(dead_code))]
pub const ULTRASHARP: &str = "4x-UltraSharp.safetensors";

pub const PROMPT_MAX_CHARS: usize = 2000;
/// SDXL Turbo is distilled for 1–4 steps; more only costs time.
pub const TURBO_MAX_STEPS: u32 = 4;
pub const SIDE_MIN: u32 = 64;
pub const SIDE_MAX: u32 = 1024;
/// Native SDXL Turbo resolution (short side for `size_for_aspect`).
pub const TURBO_BASE: u32 = 512;
pub const DENOISE_MIN: f32 = 0.1;
pub const DENOISE_MAX: f32 = 1.0;
/// img2img strength window for `style-transfer`: below 0.3 nothing changes,
/// above 0.7 the source composition is lost.
pub const STYLE_DENOISE_MIN: f32 = 0.3;
pub const STYLE_DENOISE_MAX: f32 = 0.7;
/// 4x upscale output grows 16x in pixels; comfy.rs should refuse inputs whose
/// long side exceeds this (not checked here: `fill` never touches the file).
#[allow(dead_code)] // for comfy.rs
pub const UPSCALE_MAX_INPUT_SIDE: u32 = 2048;
/// The aspects the Director manifest allows (`src/features/director/manifest.ts:35`)
/// plus 4:3 / 3:4 for stills.
pub const ASPECTS: &[&str] = &["16:9", "9:16", "4:5", "1:1", "4:3", "3:4"];

/// Appended to the `thumbnail-bg` prompt. Phrased positively on purpose (see
/// module docs: the negative prompt is inert at cfg 1.0, and "no text" in a
/// positive prompt tends to *add* text).
pub const THUMBNAIL_SUFFIX: &str = ", clean minimal composition, main subject on the right third, wide empty uncluttered area on the left for a title, soft plain background, high contrast, vivid colors";

fn default_steps() -> u32 {
    1
}
fn default_denoise() -> f32 {
    1.0
}
fn default_aspect() -> String {
    "1:1".into()
}

/// Generation parameters from the Director / UI. `width`/`height` of `0`
/// mean "derive from `aspect`" via [`size_for_aspect`] at [`TURBO_BASE`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenParams {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub negative: String,
    /// Required by `fill` (deterministic); the caller picks a random one when the user didn't.
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default = "default_steps")]
    pub steps: u32,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default = "default_aspect")]
    pub aspect: String,
    /// `style-transfer` / `upscale`: name relative to ComfyUI's input dir, or `"sub/x.png [output]"`.
    #[serde(default, alias = "input_image")]
    pub input_image: Option<String>,
    /// img2img strength; `strength` is accepted as an alias.
    #[serde(default = "default_denoise", alias = "strength")]
    pub denoise: f32,
    /// Director project slug; becomes `director/<slug>/<jobId>` in SaveImage.
    #[serde(default)]
    pub slug: String,
    /// Render job id (comfy.rs queue id).
    #[serde(default, alias = "job_id")]
    pub job_id: String,
}

impl Default for GenParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            negative: String::new(),
            seed: None,
            steps: default_steps(),
            width: 0,
            height: 0,
            aspect: default_aspect(),
            input_image: None,
            denoise: default_denoise(),
            slug: String::new(),
            job_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub name: String,
    pub label: String,
    pub description: String,
    /// Model files, relative to a model root (`checkpoints/…`, `upscale_models/…`).
    pub needs: Vec<String>,
    /// `false` here; the caller sets it (`implemented` and nothing in `missing_models`).
    pub available: bool,
    /// `false` for templates listed for planning only (`broll-motion`).
    pub implemented: bool,
    /// `"image"` or `"video"`.
    pub kind: String,
    /// What the UI should say when it is not available, e.g. "needs model checkpoints/…".
    pub unavailable_reason: Option<String>,
}

struct Template {
    name: &'static str,
    label: &'static str,
    description: &'static str,
    kind: &'static str,
    json: Option<&'static str>,
    needs: &'static [&'static str],
    outputs: &'static [&'static str],
}

const BROLL_NEEDS: &[&str] = &[
    "diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors",
    "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    "vae/wan_2.1_vae.safetensors",
];

const TEMPLATES: &[Template] = &[
    Template {
        name: "scene-still",
        label: "Scene still",
        description: "Text-to-image still for a scene or insert shot (SDXL Turbo, 1–4 steps).",
        kind: "image",
        json: Some(include_str!("../../resources/comfy/scene-still.json")),
        needs: &["checkpoints/sd_xl_turbo_1.0_fp16.safetensors"],
        outputs: &["9"],
    },
    Template {
        name: "thumbnail-bg",
        label: "Thumbnail background",
        description: "16:9 (or project aspect) background with empty space for a title. The title itself is overlaid later by media-forge, since SDXL can't spell.",
        kind: "image",
        json: Some(include_str!("../../resources/comfy/thumbnail-bg.json")),
        needs: &["checkpoints/sd_xl_turbo_1.0_fp16.safetensors"],
        outputs: &["9"],
    },
    Template {
        name: "style-transfer",
        label: "Style transfer",
        description: "Restyle an existing still (img2img, strength 0.3–0.7) with SDXL Turbo.",
        kind: "image",
        json: Some(include_str!("../../resources/comfy/style-transfer.json")),
        needs: &["checkpoints/sd_xl_turbo_1.0_fp16.safetensors"],
        outputs: &["9"],
    },
    Template {
        name: "upscale",
        label: "Upscale 4x",
        description: "4x model upscale of a still (4x-UltraSharp).",
        kind: "image",
        json: Some(include_str!("../../resources/comfy/upscale.json")),
        needs: &["upscale_models/4x-UltraSharp.safetensors"],
        outputs: &["9"],
    },
    Template {
        name: "broll-motion",
        label: "B-roll motion",
        description: "Short generated B-roll clip. Not built yet: needs a video model (e.g. Wan 2.1 T2V 1.3B or LTX-Video).",
        kind: "video",
        json: None,
        needs: BROLL_NEEDS,
        outputs: &[],
    },
];

fn find(name: &str) -> Option<&'static Template> {
    TEMPLATES.iter().find(|t| t.name == name)
}

/// All templates, `available: false` (the caller decides).
pub fn list() -> Vec<TemplateInfo> {
    TEMPLATES
        .iter()
        .map(|t| TemplateInfo {
            name: t.name.into(),
            label: t.label.into(),
            description: t.description.into(),
            needs: t.needs.iter().map(|s| s.to_string()).collect(),
            available: false,
            implemented: t.json.is_some(),
            kind: t.kind.into(),
            unavailable_reason: if t.json.is_some() { None } else { Some(format!("not built yet: needs a video model ({})", t.needs.join(", "))) },
        })
        .collect()
}

/// Model files the template needs, relative to a model root.
pub fn required_models(name: &str) -> Vec<String> {
    find(name).map(|t| t.needs.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
}

/// Ids of the template's output (SaveImage) nodes, the keys to read in `/history/{id}`.
pub fn output_node_ids(name: &str) -> Vec<String> {
    find(name).map(|t| t.outputs.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
}

/// Same folder aliases ComfyUI merges (`folder_paths.py:30-31`, `map_legacy` :112).
#[cfg_attr(not(test), allow(dead_code))]
fn folder_aliases(folder: &str) -> &'static [&'static str] {
    match folder {
        "text_encoders" | "clip" => &["text_encoders", "clip"],
        "diffusion_models" | "unet" => &["diffusion_models", "unet"],
        "checkpoints" => &["checkpoints"],
        "upscale_models" => &["upscale_models"],
        "loras" => &["loras"],
        "vae" => &["vae"],
        _ => &[],
    }
}

/// Needed model files found under none of `roots` (same layout as
/// [`extra_model_paths_yaml`]). Read-only `is_file` checks. Unknown template → `["unknown template"]`.
#[cfg_attr(not(test), allow(dead_code))] // comfy.rs uses its own D:-layout aware `missing_models`
pub fn missing_models(name: &str, roots: &[PathBuf]) -> Vec<String> {
    if find(name).is_none() {
        return vec![format!("unknown template '{name}'")];
    }
    required_models(name)
        .into_iter()
        .filter(|rel| {
            let (folder, file) = rel.split_once('/').unwrap_or(("", rel));
            !roots.iter().any(|root| folder_aliases(folder).iter().any(|f| root.join(f).join(file).is_file()))
        })
        .collect()
}

/// "needs model X" text for the UI, or None when everything is present.
#[cfg_attr(not(test), allow(dead_code))]
pub fn unavailable_reason(name: &str, roots: &[PathBuf]) -> Option<String> {
    let t = find(name)?;
    if t.json.is_none() {
        return Some(format!("not built yet: needs a video model ({})", t.needs.join(", ")));
    }
    let missing = missing_models(name, roots);
    (!missing.is_empty()).then(|| format!("needs model {}", missing.join(", ")))
}

fn round64(v: f64) -> u32 {
    ((v / 64.0).round() as u32).max(1) * 64
}

fn parse_aspect(aspect: &str) -> Option<(f64, f64)> {
    let (w, h) = aspect.trim().split_once(':')?;
    let (w, h): (f64, f64) = (w.trim().parse().ok()?, h.trim().parse().ok()?);
    (w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite()).then_some((w, h))
}

/// Pixel size for an aspect: the short side is `base` (rounded to 64, clamped
/// 64..=1024), the long side is the nearest multiple of 64 to `short × ratio`,
/// capped at 1024 (the short side then shrinks to keep the ratio). Unparseable
/// aspects fall back to square.
///
/// At SDXL Turbo's native 512 (~0.26 MP base; all results ≤ 0.5 MP):
/// `1:1` 512×512, `16:9` 896×512 (0.46 MP, 1.75:1), `9:16` 512×896,
/// `4:5` 512×640 (exact), `4:3` 704×512, `3:4` 512×704.
/// At 768: `16:9` → 1024×576 (exact 16:9, 0.59 MP).
pub fn size_for_aspect(aspect: &str, base: u32) -> (u32, u32) {
    let short = round64(base.clamp(SIDE_MIN, SIDE_MAX) as f64).clamp(SIDE_MIN, SIDE_MAX);
    let (w, h) = parse_aspect(aspect).unwrap_or((1.0, 1.0));
    let ratio = if w >= h { w / h } else { h / w };
    let mut long = round64(short as f64 * ratio);
    let mut short = short;
    if long > SIDE_MAX {
        long = SIDE_MAX;
        short = round64(SIDE_MAX as f64 / ratio).clamp(SIDE_MIN, SIDE_MAX);
    }
    if w >= h { (long, short) } else { (short, long) }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn check_text(label: &str, s: &str, required: bool) -> Result<(), String> {
    let n = s.chars().count();
    if required && s.trim().is_empty() {
        return Err(format!("{label} is empty"));
    }
    if n > PROMPT_MAX_CHARS {
        return Err(format!("{label} is {n} characters; the limit is {PROMPT_MAX_CHARS}"));
    }
    if s.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(format!("{label} contains control characters"));
    }
    Ok(())
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty() && s.len() <= 48 && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_job_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `director/<slug>/<jobId>` — the SaveImage prefix (ComfyUI writes `<prefix>_00001_.png`).
pub fn output_prefix(slug: &str, job_id: &str) -> Result<String, String> {
    if !valid_slug(slug) {
        return Err(format!("invalid project slug '{slug}' (lowercase letters, digits and '-', ≤ 48)"));
    }
    if !valid_job_id(job_id) {
        return Err(format!("invalid job id '{job_id}' (letters, digits, '-' and '_', ≤ 64)"));
    }
    Ok(format!("director/{slug}/{job_id}"))
}

/// Validates a LoadImage name: relative, forward slashes, no traversal, an
/// image extension, optional ` [input]` / ` [output]` annotation.
pub fn validate_input_image(name: &str) -> Result<(), String> {
    let (path, _annot) = match name.strip_suffix(" [output]") {
        Some(p) => (p, "output"),
        None => match name.strip_suffix(" [input]") {
            Some(p) => (p, "input"),
            None => (name, "input"),
        },
    };
    if path.is_empty() || name.len() > 255 {
        return Err("input image name is empty or too long".into());
    }
    if path.starts_with('/') || path.contains('\\') || path.contains(':') || path.contains('[') || path.contains(']') {
        return Err(format!("input image '{name}' must be a name relative to ComfyUI's input dir (or 'sub/x.png [output]'), not a path"));
    }
    if path.chars().any(|c| c.is_control() || "<>\"|?*".contains(c)) {
        return Err(format!("input image '{name}' has reserved characters"));
    }
    if path.split('/').any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.')) {
        return Err(format!("input image '{name}' has an empty, hidden or '..' path segment"));
    }
    let lower = path.to_ascii_lowercase();
    if ![".png", ".jpg", ".jpeg", ".webp"].iter().any(|e| lower.ends_with(e)) {
        return Err(format!("input image '{name}' must be .png, .jpg, .jpeg or .webp"));
    }
    Ok(())
}

fn check_seed(p: &GenParams) -> Result<u64, String> {
    p.seed.ok_or_else(|| "seed is required (the caller picks a random one and records it)".to_string())
}

fn check_steps(p: &GenParams) -> Result<u32, String> {
    if !(1..=TURBO_MAX_STEPS).contains(&p.steps) {
        return Err(format!("steps {} out of range: SDXL Turbo takes 1–{TURBO_MAX_STEPS}", p.steps));
    }
    Ok(p.steps)
}

fn check_aspect(p: &GenParams) -> Result<(), String> {
    if !ASPECTS.contains(&p.aspect.trim()) {
        return Err(format!("aspect '{}' is not one of {}", p.aspect, ASPECTS.join(", ")));
    }
    Ok(())
}

/// Explicit size, or both 0 → from aspect at [`TURBO_BASE`].
fn resolve_size(p: &GenParams) -> Result<(u32, u32), String> {
    check_aspect(p)?;
    let (w, h) = if p.width == 0 && p.height == 0 { size_for_aspect(&p.aspect, TURBO_BASE) } else { (p.width, p.height) };
    for (label, v) in [("width", w), ("height", h)] {
        if !(SIDE_MIN..=SIDE_MAX).contains(&v) || v % 64 != 0 {
            return Err(format!("{label} {v} must be a multiple of 64 between {SIDE_MIN} and {SIDE_MAX}"));
        }
    }
    Ok((w, h))
}

/// Rounds an f32 to 2 decimals as f64. SDTurboScheduler floors `10 * denoise`
/// (nodes_custom_sampler.py:152), and `0.7f32 as f64` is 0.69999998…, which
/// would silently become 0.6.
fn denoise_json(d: f32) -> f64 {
    ((d as f64) * 100.0).round() / 100.0
}

fn check_denoise(p: &GenParams, min: f32, max: f32) -> Result<f64, String> {
    let d = denoise_json(p.denoise);
    if !p.denoise.is_finite() || d < denoise_json(min) - 1e-9 || d > denoise_json(max) + 1e-9 {
        return Err(format!("denoise {} out of range {min}–{max}", p.denoise));
    }
    Ok(d)
}

/// Sampling steps SDTurboScheduler will actually run: `min(steps, floor(10·denoise))`
/// (nodes_custom_sampler.py:152-153). Store this in provenance.
#[cfg_attr(not(test), allow(dead_code))] // comfy.rs `gen_meta_from` applies the same rule
pub fn effective_steps(steps: u32, denoise: f32) -> u32 {
    let avail = (denoise_json(denoise) * 10.0 + 1e-9).floor() as u32;
    steps.min(avail)
}

fn set(graph: &mut Value, node: &str, input: &str, v: Value) -> Result<(), String> {
    let slot = graph
        .get_mut(node)
        .and_then(|n| n.get_mut("inputs"))
        .and_then(|i| i.get_mut(input))
        .ok_or_else(|| format!("template drift: node {node} has no input '{input}'"))?;
    *slot = v;
    Ok(())
}

/// Parsed, unfilled template graph.
pub fn template_graph(name: &str) -> Result<Value, String> {
    let t = find(name).ok_or_else(|| format!("unknown template '{name}'"))?;
    let src = t.json.ok_or_else(|| format!("template '{name}' is not built yet: needs a video model ({})", t.needs.join(", ")))?;
    serde_json::from_str(src).map_err(|e| format!("template '{name}' is not valid JSON: {e}"))
}

/// Fills a template into a ComfyUI API-format prompt (the value for `"prompt"`
/// in `POST /prompt`). Deterministic for the same `GenParams`.
pub fn fill(name: &str, p: &GenParams) -> Result<Value, String> {
    let mut g = template_graph(name)?;
    let prefix = output_prefix(&p.slug, &p.job_id)?;
    match name {
        "scene-still" | "thumbnail-bg" => {
            check_text("prompt", &p.prompt, true)?;
            check_text("negative prompt", &p.negative, false)?;
            let seed = check_seed(p)?;
            let steps = check_steps(p)?;
            // txt2img from an empty latent: denoise is always 1.0.
            check_denoise(p, DENOISE_MIN, DENOISE_MAX)?;
            let (w, h) = resolve_size(p)?;
            let text = if name == "thumbnail-bg" { format!("{}{}", p.prompt.trim(), THUMBNAIL_SUFFIX) } else { p.prompt.trim().to_string() };
            set(&mut g, "6", "text", json!(text))?;
            set(&mut g, "7", "text", json!(p.negative.trim()))?;
            set(&mut g, "5", "width", json!(w))?;
            set(&mut g, "5", "height", json!(h))?;
            set(&mut g, "20", "steps", json!(steps))?;
            set(&mut g, "20", "denoise", json!(1.0))?;
            set(&mut g, "13", "noise_seed", json!(seed))?;
        }
        "style-transfer" => {
            check_text("prompt", &p.prompt, true)?;
            check_text("negative prompt", &p.negative, false)?;
            let seed = check_seed(p)?;
            let steps = check_steps(p)?;
            let d = check_denoise(p, STYLE_DENOISE_MIN, STYLE_DENOISE_MAX)?;
            let (w, h) = resolve_size(p)?;
            let img = p.input_image.as_deref().ok_or("style-transfer needs inputImage")?;
            validate_input_image(img)?;
            set(&mut g, "10", "image", json!(img))?;
            set(&mut g, "11", "width", json!(w))?;
            set(&mut g, "11", "height", json!(h))?;
            set(&mut g, "6", "text", json!(p.prompt.trim()))?;
            set(&mut g, "7", "text", json!(p.negative.trim()))?;
            set(&mut g, "20", "steps", json!(steps))?;
            set(&mut g, "20", "denoise", json!(d))?;
            set(&mut g, "13", "noise_seed", json!(seed))?;
        }
        "upscale" => {
            let img = p.input_image.as_deref().ok_or("upscale needs inputImage")?;
            validate_input_image(img)?;
            set(&mut g, "10", "image", json!(img))?;
        }
        other => return Err(format!("template '{other}' has no fill rules")),
    }
    for id in output_node_ids(name) {
        set(&mut g, &id, "filename_prefix", json!(prefix))?;
    }
    validate_graph(&g)?;
    Ok(g)
}

// ---------------------------------------------------------------------------
// Graph schema (ComfyUI v0.46.0 core nodes, read from C:\ComfyUI\…\ComfyUI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub enum In {
    /// A link `["<node id>", <output index>]` whose output has this type.
    Link(&'static str),
    Int { min: i128, max: i128 },
    Float { min: f64, max: f64 },
    Bool,
    Str,
    /// Combo with a fixed option list (checked).
    Combo(&'static [&'static str]),
    /// Combo whose options are files on disk (string, checked by ComfyUI).
    FileCombo,
}

pub struct NodeSpec {
    pub class_type: &'static str,
    /// Source location in ComfyUI v0.46.0.
    pub source: &'static str,
    pub inputs: &'static [(&'static str, In)],
    pub outputs: &'static [&'static str],
    pub output_node: bool,
}

const U64_MAX: i128 = u64::MAX as i128;
const MAX_RES: i128 = 16384; // nodes.py:56 MAX_RESOLUTION
const UPSCALE_METHODS: &[&str] = &["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]; // nodes.py:1893
const CROP_METHODS: &[&str] = &["disabled", "center"]; // nodes.py:1894
/// Subset of comfy/samplers.py:971 KSAMPLER_NAMES the templates use.
const SAMPLERS_USED: &[&str] = &["euler", "euler_ancestral"];

/// Allowlist of every class_type the templates may use, with input names and
/// types copied from the v0.46.0 source. Anything else is rejected.
pub const NODE_SPECS: &[NodeSpec] = &[
    // nodes.py:621-629, registered nodes.py:2079
    NodeSpec { class_type: "CheckpointLoaderSimple", source: "nodes.py:621", inputs: &[("ckpt_name", In::FileCombo)], outputs: &["MODEL", "CLIP", "VAE"], output_node: false },
    // nodes.py:58-67, registered nodes.py:2080
    NodeSpec { class_type: "CLIPTextEncode", source: "nodes.py:58", inputs: &[("text", In::Str), ("clip", In::Link("CLIP"))], outputs: &["CONDITIONING"], output_node: false },
    // nodes.py:1255-1265, registered nodes.py:2086
    NodeSpec {
        class_type: "EmptyLatentImage",
        source: "nodes.py:1255",
        inputs: &[("width", In::Int { min: 16, max: MAX_RES }), ("height", In::Int { min: 16, max: MAX_RES }), ("batch_size", In::Int { min: 1, max: 4096 })],
        outputs: &["LATENT"],
        output_node: false,
    },
    // nodes.py:321-330, registered nodes.py:2082
    NodeSpec { class_type: "VAEDecode", source: "nodes.py:321", inputs: &[("samples", In::Link("LATENT")), ("vae", In::Link("VAE"))], outputs: &["IMAGE"], output_node: false },
    // nodes.py:385-389, registered nodes.py:2083
    NodeSpec { class_type: "VAEEncode", source: "nodes.py:385", inputs: &[("pixels", In::Link("IMAGE")), ("vae", In::Link("VAE"))], outputs: &["LATENT"], output_node: false },
    // nodes.py:1669-1695 (OUTPUT_NODE), registered nodes.py:2091
    NodeSpec { class_type: "SaveImage", source: "nodes.py:1669", inputs: &[("images", In::Link("IMAGE")), ("filename_prefix", In::Str)], outputs: &["IMAGE"], output_node: true },
    // nodes.py:1747-1761 (VALIDATE_INPUTS :1817), registered nodes.py:2093
    NodeSpec { class_type: "LoadImage", source: "nodes.py:1747", inputs: &[("image", In::FileCombo)], outputs: &["IMAGE", "MASK"], output_node: false },
    // nodes.py:1892-1902, registered nodes.py:2096
    NodeSpec {
        class_type: "ImageScale",
        source: "nodes.py:1892",
        inputs: &[
            ("image", In::Link("IMAGE")),
            ("upscale_method", In::Combo(UPSCALE_METHODS)),
            ("width", In::Int { min: 0, max: MAX_RES }),
            ("height", In::Int { min: 0, max: MAX_RES }),
            ("crop", In::Combo(CROP_METHODS)),
        ],
        outputs: &["IMAGE"],
        output_node: false,
    },
    // comfy_extras/nodes_custom_sampler.py:136-147, listed :1200
    NodeSpec {
        class_type: "SDTurboScheduler",
        source: "comfy_extras/nodes_custom_sampler.py:136",
        inputs: &[("model", In::Link("MODEL")), ("steps", In::Int { min: 1, max: 10 }), ("denoise", In::Float { min: 0.0, max: 1.0 })],
        outputs: &["SIGMAS"],
        output_node: false,
    },
    // comfy_extras/nodes_custom_sampler.py:379-386, listed :1201
    NodeSpec { class_type: "KSamplerSelect", source: "comfy_extras/nodes_custom_sampler.py:379", inputs: &[("sampler_name", In::Combo(SAMPLERS_USED))], outputs: &["SAMPLER"], output_node: false },
    // comfy_extras/nodes_custom_sampler.py:733-753, listed :1191
    NodeSpec {
        class_type: "SamplerCustom",
        source: "comfy_extras/nodes_custom_sampler.py:733",
        inputs: &[
            ("model", In::Link("MODEL")),
            ("add_noise", In::Bool),
            ("noise_seed", In::Int { min: 0, max: U64_MAX }),
            ("cfg", In::Float { min: 0.0, max: 100.0 }),
            ("positive", In::Link("CONDITIONING")),
            ("negative", In::Link("CONDITIONING")),
            ("sampler", In::Link("SAMPLER")),
            ("sigmas", In::Link("SIGMAS")),
            ("latent_image", In::Link("LATENT")),
        ],
        outputs: &["LATENT", "LATENT"],
        output_node: false,
    },
    // comfy_extras/nodes_upscale_model.py:21-32
    NodeSpec { class_type: "UpscaleModelLoader", source: "comfy_extras/nodes_upscale_model.py:21", inputs: &[("model_name", In::FileCombo)], outputs: &["UPSCALE_MODEL"], output_node: false },
    // comfy_extras/nodes_upscale_model.py:53-66
    NodeSpec {
        class_type: "ImageUpscaleWithModel",
        source: "comfy_extras/nodes_upscale_model.py:53",
        inputs: &[("upscale_model", In::Link("UPSCALE_MODEL")), ("image", In::Link("IMAGE"))],
        outputs: &["IMAGE"],
        output_node: false,
    },
];

pub fn node_spec(class_type: &str) -> Option<&'static NodeSpec> {
    NODE_SPECS.iter().find(|s| s.class_type == class_type)
}

/// Structural check of an API-format prompt: every node's class_type is in
/// [`NODE_SPECS`], inputs match the spec exactly (no missing, no unknown),
/// literals have the right type and range, links point at an existing node id
/// and output index of the expected type, there is at least one output node,
/// and the graph has no cycles.
pub fn validate_graph(g: &Value) -> Result<(), String> {
    let nodes = g.as_object().ok_or("prompt is not an object")?;
    if nodes.is_empty() {
        return Err("prompt has no nodes".into());
    }
    let mut has_output = false;
    for (id, node) in nodes {
        let class = node.get("class_type").and_then(Value::as_str).ok_or_else(|| format!("node {id}: missing class_type"))?;
        let spec = node_spec(class).ok_or_else(|| format!("node {id}: class_type '{class}' is not allowlisted"))?;
        has_output |= spec.output_node;
        let inputs = node.get("inputs").and_then(Value::as_object).ok_or_else(|| format!("node {id}: missing inputs"))?;
        for k in inputs.keys() {
            if !spec.inputs.iter().any(|(n, _)| n == k) {
                return Err(format!("node {id} ({class}, {}): unknown input '{k}'", spec.source));
            }
        }
        for (iname, kind) in spec.inputs {
            let v = inputs.get(*iname).ok_or_else(|| format!("node {id} ({class}): missing input '{iname}'"))?;
            let bad = |what: &str| format!("node {id} ({class}).{iname}: {what}, got {v}");
            match kind {
                In::Link(ty) => {
                    let arr = v.as_array().filter(|a| a.len() == 2).ok_or_else(|| bad("expected a link [id, index]"))?;
                    let src = arr[0].as_str().ok_or_else(|| bad("link source id must be a string"))?;
                    let idx = arr[1].as_u64().ok_or_else(|| bad("link index must be a non-negative integer"))? as usize;
                    let src_node = nodes.get(src).ok_or_else(|| bad("link points at a missing node"))?;
                    let src_class = src_node.get("class_type").and_then(Value::as_str).unwrap_or("");
                    let src_spec = node_spec(src_class).ok_or_else(|| bad("link source class is not allowlisted"))?;
                    let out = src_spec.outputs.get(idx).ok_or_else(|| bad("link index past the source's outputs"))?;
                    if out != ty {
                        return Err(bad(&format!("expected {ty}, link gives {out}")));
                    }
                }
                In::Int { min, max } => {
                    let n = v.as_u64().map(|n| n as i128).or_else(|| v.as_i64().map(|n| n as i128)).ok_or_else(|| bad("expected an integer"))?;
                    if n < *min || n > *max {
                        return Err(bad(&format!("out of range {min}..={max}")));
                    }
                }
                In::Float { min, max } => {
                    let n = v.as_f64().ok_or_else(|| bad("expected a number"))?;
                    if !(n >= *min && n <= *max) {
                        return Err(bad(&format!("out of range {min}..={max}")));
                    }
                }
                In::Bool => {
                    v.as_bool().ok_or_else(|| bad("expected a boolean"))?;
                }
                In::Str | In::FileCombo => {
                    let s = v.as_str().ok_or_else(|| bad("expected a string"))?;
                    if matches!(kind, In::FileCombo) && s.is_empty() {
                        return Err(bad("expected a file name"));
                    }
                }
                In::Combo(opts) => {
                    let s = v.as_str().ok_or_else(|| bad("expected a string"))?;
                    if !opts.contains(&s) {
                        return Err(bad(&format!("expected one of {}", opts.join(", "))));
                    }
                }
            }
        }
    }
    if !has_output {
        return Err("prompt has no output node".into());
    }
    // Cycle check (DFS over link edges).
    fn visit<'a>(id: &'a str, nodes: &'a serde_json::Map<String, Value>, state: &mut std::collections::HashMap<&'a str, u8>) -> Result<(), String> {
        match state.get(id) {
            Some(1) => return Err(format!("cycle through node {id}")),
            Some(2) => return Ok(()),
            _ => {}
        }
        state.insert(id, 1);
        if let Some(inputs) = nodes.get(id).and_then(|n| n.get("inputs")).and_then(Value::as_object) {
            for v in inputs.values() {
                if let Some(src) = v.as_array().filter(|a| a.len() == 2).and_then(|a| a[0].as_str()) {
                    if let Some((k, _)) = nodes.get_key_value(src) {
                        visit(k.as_str(), nodes, state)?;
                    }
                }
            }
        }
        state.insert(id, 2);
        Ok(())
    }
    let mut state = std::collections::HashMap::new();
    for id in nodes.keys() {
        visit(id.as_str(), nodes, &mut state)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// extra_model_paths.yaml
// ---------------------------------------------------------------------------

/// Category → subfolders under each root, in ComfyUI's own layout
/// (folder_paths.py:25-41; `clip`/`unet` are the legacy names ComfyUI maps to
/// `text_encoders`/`diffusion_models`, folder_paths.py:112).
// comfy.rs writes the live yaml (its own D:-layout aware generator); this one is kept, tested.
#[cfg_attr(not(test), allow(dead_code))]
const YAML_FOLDERS: &[(&str, &[&str])] = &[
    ("checkpoints", &["checkpoints/"]),
    ("text_encoders", &["text_encoders/", "clip/"]),
    ("diffusion_models", &["diffusion_models/", "unet/"]),
    ("vae", &["vae/"]),
    ("loras", &["loras/"]),
    ("upscale_models", &["upscale_models/"]),
];

#[cfg_attr(not(test), allow(dead_code))]
fn yaml_single_quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Builds an `extra_model_paths.yaml` (read by utils/extra_config.py:6) with one
/// section per root: `base_path: <root>` plus the subfolders above. Roots that
/// are not absolute or contain control characters are skipped with a comment.
/// With no usable root it still emits a null section, because ComfyUI iterates
/// the parsed document and an all-comment file parses to `None` and crashes
/// (extra_config.py:10); a null section is skipped (extra_config.py:12).
///
/// Each root must use ComfyUI's layout (`<root>/checkpoints/<file>`). A store
/// laid out per model (e.g. `D:\AI Models Media and Vision\sdxl-turbo\…`) needs
/// a root whose `checkpoints` folder is a directory junction to it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn extra_model_paths_yaml(roots: &[PathBuf]) -> String {
    let mut out = String::from("# Generated by Command Center (comfy_templates.rs). Rewritten on every ComfyUI start; do not edit.\n");
    let mut n = 0usize;
    for root in roots {
        let s = root.to_string_lossy();
        if !Path::new(root).is_absolute() || s.chars().any(char::is_control) {
            out.push_str(&format!("# skipped root (must be an absolute path): {}\n", s.chars().filter(|c| !c.is_control()).collect::<String>()));
            continue;
        }
        out.push_str(&format!("director_root_{n}:\n  base_path: {}\n", yaml_single_quoted(&s)));
        for (cat, subs) in YAML_FOLDERS {
            if subs.len() == 1 {
                out.push_str(&format!("  {cat}: {}\n", subs[0]));
            } else {
                out.push_str(&format!("  {cat}: |\n"));
                for sub in *subs {
                    out.push_str(&format!("    {sub}\n"));
                }
            }
        }
        n += 1;
    }
    if n == 0 {
        out.push_str("director_no_roots:\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> GenParams {
        GenParams { prompt: "a rainy neon street at night".into(), seed: Some(42), steps: 2, slug: "rain-reel".into(), job_id: "job_01".into(), ..Default::default() }
    }

    fn input(g: &Value, node: &str, k: &str) -> Value {
        g[node]["inputs"][k].clone()
    }

    #[test]
    fn every_template_json_is_structurally_valid() {
        for t in TEMPLATES {
            let Some(_) = t.json else { continue };
            let g = template_graph(t.name).unwrap();
            validate_graph(&g).unwrap_or_else(|e| panic!("{}: {e}", t.name));
            for id in output_node_ids(t.name) {
                let cls = g[&id]["class_type"].as_str().unwrap();
                assert!(node_spec(cls).unwrap().output_node, "{}: {id} is not an output node", t.name);
            }
            // Every node is reachable from an output node (no dead branches).
            let mut seen = std::collections::HashSet::new();
            let mut stack: Vec<String> = output_node_ids(t.name);
            while let Some(id) = stack.pop() {
                if !seen.insert(id.clone()) {
                    continue;
                }
                for v in g[&id]["inputs"].as_object().unwrap().values() {
                    if let Some(a) = v.as_array() {
                        stack.push(a[0].as_str().unwrap().to_string());
                    }
                }
            }
            assert_eq!(seen.len(), g.as_object().unwrap().len(), "{}: unreachable nodes", t.name);
        }
    }

    #[test]
    fn filled_templates_validate_and_are_deterministic() {
        let mut p = params();
        for name in ["scene-still", "thumbnail-bg"] {
            let a = fill(name, &p).unwrap();
            assert_eq!(a, fill(name, &p).unwrap());
            validate_graph(&a).unwrap();
        }
        p.input_image = Some("director/rain-reel/still_00001_.png [output]".into());
        p.denoise = 0.5;
        for name in ["style-transfer", "upscale"] {
            let a = fill(name, &p).unwrap();
            assert_eq!(a, fill(name, &p).unwrap());
        }
    }

    #[test]
    fn scene_still_slots() {
        let g = fill("scene-still", &GenParams { aspect: "9:16".into(), negative: "blurry".into(), ..params() }).unwrap();
        assert_eq!(input(&g, "4", "ckpt_name"), json!(SDXL_TURBO_CKPT));
        assert_eq!(input(&g, "6", "text"), json!("a rainy neon street at night"));
        assert_eq!(input(&g, "7", "text"), json!("blurry"));
        assert_eq!((input(&g, "5", "width"), input(&g, "5", "height")), (json!(512), json!(896)));
        assert_eq!(input(&g, "20", "steps"), json!(2));
        assert_eq!(input(&g, "20", "denoise"), json!(1.0));
        assert_eq!(input(&g, "13", "noise_seed"), json!(42));
        assert_eq!(input(&g, "13", "cfg"), json!(1.0));
        assert_eq!(input(&g, "13", "add_noise"), json!(true));
        assert_eq!(input(&g, "14", "sampler_name"), json!("euler_ancestral"));
        assert_eq!(input(&g, "9", "filename_prefix"), json!("director/rain-reel/job_01"));
        // Full u64 seed survives.
        let g = fill("scene-still", &GenParams { seed: Some(u64::MAX), ..params() }).unwrap();
        assert_eq!(input(&g, "13", "noise_seed"), json!(u64::MAX));
    }

    #[test]
    fn thumbnail_adds_suffix_and_defaults_to_project_aspect() {
        let g = fill("thumbnail-bg", &GenParams { aspect: "16:9".into(), ..params() }).unwrap();
        let text = input(&g, "6", "text");
        assert!(text.as_str().unwrap().starts_with("a rainy neon street at night, clean minimal composition"));
        assert_eq!((input(&g, "5", "width"), input(&g, "5", "height")), (json!(896), json!(512)));
        assert!(!THUMBNAIL_SUFFIX.to_lowercase().contains("no text"));
    }

    #[test]
    fn style_transfer_slots_and_denoise_rounding() {
        let p = GenParams { input_image: Some("still.png".into()), denoise: 0.7, width: 768, height: 512, aspect: "4:3".into(), ..params() };
        let g = fill("style-transfer", &p).unwrap();
        assert_eq!(input(&g, "10", "image"), json!("still.png"));
        assert_eq!((input(&g, "11", "width"), input(&g, "11", "height")), (json!(768), json!(512)));
        // 0.7f32 must reach ComfyUI as 0.7, not 0.69999998 (floor(10·d) would give 6).
        assert_eq!(input(&g, "20", "denoise"), json!(0.7));
        assert_eq!(input(&g, "13", "latent_image"), json!(["12", 0]));
        assert_eq!(effective_steps(4, 0.3), 3);
        assert_eq!(effective_steps(2, 0.7), 2);
        assert_eq!(effective_steps(4, 0.7), 4);
        for bad in [0.2_f32, 0.75, 1.0, f32::NAN] {
            assert!(fill("style-transfer", &GenParams { denoise: bad, ..p.clone() }).unwrap_err().contains("denoise"), "{bad}");
        }
        assert!(fill("style-transfer", &GenParams { input_image: None, ..p.clone() }).unwrap_err().contains("inputImage"));
    }

    #[test]
    fn upscale_needs_only_image_and_prefix() {
        let p = GenParams { prompt: String::new(), seed: None, input_image: Some("a.png".into()), slug: "x".into(), job_id: "j".into(), ..Default::default() };
        let g = fill("upscale", &p).unwrap();
        assert_eq!(input(&g, "30", "model_name"), json!(ULTRASHARP));
        assert_eq!(input(&g, "10", "image"), json!("a.png"));
        assert_eq!(input(&g, "9", "filename_prefix"), json!("director/x/j"));
    }

    #[test]
    fn broll_is_listed_but_cannot_fill() {
        let info = list().into_iter().find(|t| t.name == "broll-motion").unwrap();
        assert!(!info.implemented && !info.available && info.kind == "video");
        assert!(info.unavailable_reason.unwrap().contains("video model"));
        let e = fill("broll-motion", &params()).unwrap_err();
        assert!(e.contains("not built yet") && e.contains("video model"), "{e}");
        assert!(output_node_ids("broll-motion").is_empty());
        assert!(fill("nope", &params()).unwrap_err().contains("unknown template"));
    }

    #[test]
    fn list_and_required_models() {
        let names: Vec<_> = list().into_iter().map(|t| t.name).collect();
        assert_eq!(names, ["scene-still", "thumbnail-bg", "style-transfer", "upscale", "broll-motion"]);
        assert!(list().iter().all(|t| !t.available));
        assert_eq!(required_models("scene-still"), ["checkpoints/sd_xl_turbo_1.0_fp16.safetensors"]);
        assert_eq!(required_models("upscale"), ["upscale_models/4x-UltraSharp.safetensors"]);
        assert!(required_models("nope").is_empty());
        // The checkpoint/upscaler names inside the JSON match required_models.
        assert!(required_models("scene-still")[0].ends_with(template_graph("scene-still").unwrap()["4"]["inputs"]["ckpt_name"].as_str().unwrap()));
        assert!(required_models("upscale")[0].ends_with(template_graph("upscale").unwrap()["30"]["inputs"]["model_name"].as_str().unwrap()));
    }

    #[test]
    fn missing_models_checks_roots_and_legacy_aliases() {
        let dir = std::env::temp_dir().join(format!("comfy-templates-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let roots = vec![dir.join("a"), dir.join("b")];
        assert_eq!(missing_models("scene-still", &roots), ["checkpoints/sd_xl_turbo_1.0_fp16.safetensors"]);
        assert_eq!(unavailable_reason("scene-still", &roots).unwrap(), "needs model checkpoints/sd_xl_turbo_1.0_fp16.safetensors");
        std::fs::create_dir_all(roots[1].join("checkpoints")).unwrap();
        std::fs::write(roots[1].join("checkpoints").join(SDXL_TURBO_CKPT), b"x").unwrap();
        assert!(missing_models("scene-still", &roots).is_empty());
        assert!(unavailable_reason("scene-still", &roots).is_none());
        assert_eq!(missing_models("upscale", &roots), ["upscale_models/4x-UltraSharp.safetensors"]);
        // text_encoders/… is satisfied by the legacy clip/ folder.
        std::fs::create_dir_all(roots[0].join("clip")).unwrap();
        std::fs::write(roots[0].join("clip").join("umt5_xxl_fp8_e4m3fn_scaled.safetensors"), b"x").unwrap();
        assert!(!missing_models("broll-motion", &roots).iter().any(|m| m.starts_with("text_encoders/")));
        assert!(unavailable_reason("broll-motion", &roots).unwrap().contains("not built yet"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn param_validation() {
        let ok = params();
        let err = |p: GenParams| fill("scene-still", &p).unwrap_err();
        assert!(err(GenParams { prompt: "   ".into(), ..ok.clone() }).contains("prompt is empty"));
        assert!(err(GenParams { prompt: "é".repeat(2001), ..ok.clone() }).contains("2001 characters"));
        assert!(fill("scene-still", &GenParams { prompt: "é".repeat(2000), ..ok.clone() }).is_ok());
        assert!(err(GenParams { negative: "x".repeat(2001), ..ok.clone() }).contains("negative prompt"));
        assert!(err(GenParams { prompt: "a\u{0}b".into(), ..ok.clone() }).contains("control"));
        assert!(err(GenParams { seed: None, ..ok.clone() }).contains("seed is required"));
        assert!(err(GenParams { steps: 0, ..ok.clone() }).contains("steps"));
        assert!(err(GenParams { steps: 5, ..ok.clone() }).contains("steps"));
        assert!(fill("scene-still", &GenParams { steps: 4, ..ok.clone() }).is_ok());
        assert!(err(GenParams { width: 1088, height: 512, ..ok.clone() }).contains("width 1088"));
        assert!(err(GenParams { width: 500, height: 512, ..ok.clone() }).contains("multiple of 64"));
        assert!(err(GenParams { width: 512, height: 0, ..ok.clone() }).contains("height 0"));
        assert!(fill("scene-still", &GenParams { width: 1024, height: 1024, ..ok.clone() }).is_ok());
        assert!(err(GenParams { aspect: "21:9".into(), ..ok.clone() }).contains("aspect"));
        assert!(err(GenParams { denoise: 0.05, ..ok.clone() }).contains("denoise"));
        assert!(err(GenParams { denoise: 1.5, ..ok.clone() }).contains("denoise"));
        assert!(err(GenParams { slug: "".into(), ..ok.clone() }).contains("slug"));
        assert!(err(GenParams { slug: "../x".into(), ..ok.clone() }).contains("slug"));
        assert!(err(GenParams { slug: "Caps".into(), ..ok.clone() }).contains("slug"));
        assert!(err(GenParams { job_id: "a/b".into(), ..ok.clone() }).contains("job id"));
        assert!(err(GenParams { job_id: "x".repeat(65), ..ok.clone() }).contains("job id"));
    }

    #[test]
    fn input_image_names() {
        for good in ["a.png", "sub/still.JPG", "director/rain-reel/job_01_00001_.png [output]", "x.webp [input]"] {
            validate_input_image(good).unwrap_or_else(|e| panic!("{good}: {e}"));
        }
        for bad in ["", "C:/x.png", "C:\\x.png", "/etc/x.png", "../x.png", "a/../x.png", "a//x.png", ".hidden.png", "x.gif", "x.png [temp]", "a\\b.png", "x\n.png", "x?.png", "[output]"] {
            assert!(validate_input_image(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn aspect_sizes() {
        assert_eq!(size_for_aspect("1:1", 512), (512, 512));
        assert_eq!(size_for_aspect("16:9", 512), (896, 512));
        assert_eq!(size_for_aspect("9:16", 512), (512, 896));
        assert_eq!(size_for_aspect("4:5", 512), (512, 640));
        assert_eq!(size_for_aspect("4:3", 512), (704, 512));
        assert_eq!(size_for_aspect("3:4", 512), (512, 704));
        assert_eq!(size_for_aspect("16:9", 768), (1024, 576));
        assert_eq!(size_for_aspect("9:16", 1024), (576, 1024));
        assert_eq!(size_for_aspect("1:1", 4000), (1024, 1024));
        assert_eq!(size_for_aspect("1:1", 10), (64, 64));
        assert_eq!(size_for_aspect("garbage", 512), (512, 512));
        assert_eq!(size_for_aspect("0:1", 512), (512, 512));
        for a in ASPECTS {
            for base in [256, 512, 640, 768, 1024] {
                let (w, h) = size_for_aspect(a, base);
                assert!(w % 64 == 0 && h % 64 == 0 && (64..=1024).contains(&w) && (64..=1024).contains(&h), "{a}@{base}: {w}x{h}");
            }
            let (w, h) = size_for_aspect(a, TURBO_BASE);
            let mp = (w * h) as f64 / 1e6;
            assert!((0.25..=0.5).contains(&mp), "{a}: {mp} MP");
        }
    }

    #[test]
    fn graph_validator_rejects_broken_graphs() {
        let base = fill("scene-still", &params()).unwrap();
        let mutate = |f: &dyn Fn(&mut Value)| {
            let mut g = base.clone();
            f(&mut g);
            validate_graph(&g).unwrap_err()
        };
        assert!(mutate(&|g| g["8"]["class_type"] = json!("VAEDecodeTiled")).contains("not allowlisted"));
        assert!(mutate(&|g| g["8"]["inputs"]["samples"] = json!(["99", 0])).contains("missing node"));
        assert!(mutate(&|g| g["8"]["inputs"]["samples"] = json!(["13", 2])).contains("past the source"));
        assert!(mutate(&|g| g["8"]["inputs"]["samples"] = json!(["4", 0])).contains("expected LATENT"));
        assert!(mutate(&|g| {
            g["8"]["inputs"].as_object_mut().unwrap().remove("vae");
        })
        .contains("missing input 'vae'"));
        assert!(mutate(&|g| g["8"]["inputs"]["tile_size"] = json!(512)).contains("unknown input"));
        assert!(mutate(&|g| g["20"]["inputs"]["steps"] = json!(11)).contains("out of range"));
        assert!(mutate(&|g| g["20"]["inputs"]["steps"] = json!("1")).contains("integer"));
        assert!(mutate(&|g| g["14"]["inputs"]["sampler_name"] = json!("dpmpp_9m")).contains("one of"));
        assert!(mutate(&|g| g["13"]["inputs"]["add_noise"] = json!(1)).contains("boolean"));
        assert!(mutate(&|g| {
            g.as_object_mut().unwrap().remove("9");
        })
        .contains("no output node"));
        assert!(mutate(&|g| g["4"]["inputs"]["ckpt_name"] = json!("")).contains("file name"));
        // A cycle that still type-checks: feed the decoded image back into a VAEEncode chain.
        let mut g = fill("style-transfer", &GenParams { input_image: Some("a.png".into()), denoise: 0.5, ..params() }).unwrap();
        g["11"]["inputs"]["image"] = json!(["8", 0]);
        assert!(validate_graph(&g).unwrap_err().contains("cycle"));
    }

    #[test]
    fn genparams_serde_camel_case_with_defaults() {
        let p: GenParams = serde_json::from_value(json!({ "prompt": "x", "seed": 7, "inputImage": "a.png", "jobId": "j1", "slug": "s" })).unwrap();
        assert_eq!(p.steps, 1);
        assert_eq!(p.denoise, 1.0);
        assert_eq!(p.aspect, "1:1");
        assert_eq!((p.width, p.height), (0, 0));
        assert_eq!(p.input_image.as_deref(), Some("a.png"));
        assert_eq!(p.job_id, "j1");
        let q: GenParams = serde_json::from_value(json!({ "input_image": "b.png", "job_id": "j2", "strength": 0.4 })).unwrap();
        assert_eq!((q.input_image.as_deref(), q.job_id.as_str(), q.denoise), (Some("b.png"), "j2", 0.4));
        let info = serde_json::to_value(&list()[0]).unwrap();
        assert!(info.get("unavailableReason").is_some() && info.get("needs").is_some());
    }

    #[test]
    fn yaml_output_exact() {
        let roots = vec![PathBuf::from(r"G:\ai-hub\comfy\models"), PathBuf::from("relative/models"), PathBuf::from(r"D:\Model's Store")];
        let expected = "# Generated by Command Center (comfy_templates.rs). Rewritten on every ComfyUI start; do not edit.\n\
director_root_0:\n  base_path: 'G:\\ai-hub\\comfy\\models'\n  checkpoints: checkpoints/\n  text_encoders: |\n    text_encoders/\n    clip/\n  diffusion_models: |\n    diffusion_models/\n    unet/\n  vae: vae/\n  loras: loras/\n  upscale_models: upscale_models/\n\
# skipped root (must be an absolute path): relative/models\n\
director_root_1:\n  base_path: 'D:\\Model''s Store'\n  checkpoints: checkpoints/\n  text_encoders: |\n    text_encoders/\n    clip/\n  diffusion_models: |\n    diffusion_models/\n    unet/\n  vae: vae/\n  loras: loras/\n  upscale_models: upscale_models/\n";
        // On non-Windows hosts the drive-letter paths are not absolute; this module only runs on Windows.
        if cfg!(windows) {
            assert_eq!(extra_model_paths_yaml(&roots), expected);
        }
        assert_eq!(
            extra_model_paths_yaml(&[]),
            "# Generated by Command Center (comfy_templates.rs). Rewritten on every ComfyUI start; do not edit.\ndirector_no_roots:\n"
        );
    }
}
