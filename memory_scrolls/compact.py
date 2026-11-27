"""`compact-memory`: the host orchestrator. The only path that writes archives, scrolls, the KG and
AnythingLLM during compaction (in that order: archive + verify first, then distill, then write).
"""

from __future__ import annotations

import datetime as _dt
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import archive, config, distill, graph, guards, keys, lmstudio, privacy, scrub, sources, state, sync
from . import scroll as sc
from . import stale_claims
from .allm import RequestTrace
from .errors import ArchiveError, Deferred, ScrollError
from .fsutil import ProcessLock
from .net import short_error
from .scroll_store import write_scroll

MAX_ATTEMPTS = 3
MAX_KG_PENDING = 20
MAX_ENTITIES = 24

Emit = Callable[[Dict[str, Any]], None]


@dataclass
class CompactOptions:
    dry_run: bool = False
    max_batches: int = 4
    assume_idle: bool = False
    replay_llm: Optional[Path] = None
    include_training_logs: bool = False
    include_gateway_chat: bool = False
    now: Optional[_dt.datetime] = None
    llm: Any = None  # injected transport (tests)


def _now(opts: CompactOptions) -> _dt.datetime:
    return (opts.now or _dt.datetime.now()).astimezone()


def _phase(emit: Emit, name: str) -> None:
    emit({"event": "phase", "phase": name})


# ── one target ──────────────────────────────────────────────────────────────


class BudgetSpent(Exception):
    pass


SECRET_IN_REPLY = "secret-like content in the reply"


def _strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for k, x in v.items():
            yield str(k)
            yield from _strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from _strings(x)


def _has_secret(reply, known: List[str]) -> bool:
    """Checked on the RAW reply, before any repair could drop the line or entity holding it."""
    return any(scrub.scrub(x, known) != x for x in _strings(reply))


def _snips(lines: List[str], known: List[str]) -> str:
    return "; ".join(sc.one_line(scrub.scrub(x, known), 50) for x in lines[:3]) + (" ..." if len(lines) > 3 else "")


def _prepare_reply(t: sc.Target, reply: dict, chunk: str, cur_body: str, known: List[str], prior_facts: List[dict] = (), policy: Optional[privacy.Policy] = None, stats: Optional[Dict[str, Any]] = None, lock_new: bool = True, hint: str = "",
                   stale: Optional[stale_claims.Policy] = None, new_scroll: bool = False, plans: Optional[guards.PlanIndex] = None):
    """(reply, warnings): harmless model variance repaired before the strict `sc.validate`.

    entityType synonyms / malformed single entities or facts (`distill.normalize_reply`), personal
    data the privacy `policy` excludes from Tier 2 (body lines, facts, entities: removed and counted
    by category), lines that echo the distiller's own prompt, body lines that still state a
    superseded fact verbatim, changelog / template lines in ## Superseded Decisions, and NEW one-off
    / idea bullets under a locked heading (moved, never deleted: the never-lock gate). A body with
    frontmatter that disagrees with the target is left as-is for `sc.validate` to reject.

    Existing locked bullets the reply moved to another section go back under their locked heading
    (`distill.relock_existing`), so a reply can never unlock a decision.

    `cur_body` must already be privacy-filtered (`distill_target` does that), so a locked bullet
    only disappears as a counted, separately reported privacy removal. `stats` (optional) receives
    {"privacy": tally, "demoted": [(kind, heading)], "relocked": [heading]} for this reply.
    `lock_new=False`: no NEW locked bullet survives (a transient target). `hint`: host text added to
    this prompt (source priority, ...); a line echoing it is removed like a rule echo.

    Content guards (`guards`, after the privacy filter; `stale` default: the built-in stale-claims
    policy): the H1 is normalised to the target title; dispatcher-envelope echoes, lines / facts that
    relabel the user as an agent and person entities other than the operator are dropped; a NEW
    stale claim is dropped (bullet, fact, KG observation) and a contested one demoted out of the
    locked sections as "(unconfirmed)"; a malformed ## Superseded Decisions line is dropped (the
    host writes the clean one); near-duplicate KG entities are merged. Lines of `cur_body` are never
    touched by these guards (the current scroll was filtered already). `stats["guards"]` receives
    the counts (rule ids / kinds only).

    Guards v3 (`guards.content_body` / `content_entities`): `new_scroll` (the target has no prior
    version) drops every model-written superseded fact and ## Superseded Decisions line, and a no-op
    one ("X -> Same") always goes; NEW transient status lines (online / offline, timestamps) go, Key
    Paths keep only real, correctly labelled paths; agent imperatives (delete / download / export /
    send / change config / outside services) become "(needs Nic's approval)" Open Threads (dropped
    elsewhere); lines restating a plan of `plans` (ROADMAP / plan / goal files) become "Planned:"
    Open Threads, unless a status line says it better (the dated status wins).
    """
    policy = policy or privacy.default_policy()
    stale = stale or stale_claims.default_policy()
    reply, norm_w = distill.normalize_reply(reply)
    warnings = [f"{t.scroll_id}: {w}" for w in norm_w]
    if not isinstance(reply, dict) or not isinstance(reply.get("updated_markdown"), str):
        return reply, warnings
    md, fm_err = sc.strip_body_frontmatter(t, reply["updated_markdown"])
    if fm_err:
        return reply, warnings
    # Personal data first: nothing below may copy a personal value into the log or another section.
    md, p_body = privacy.filter_body(md, policy)
    facts, p_facts = privacy.filter_facts(reply["superseded_facts"], policy)
    ents, p_ents = privacy.filter_entities(reply["graph_entities_to_upsert"], policy)
    # The extractive "Pending distillation" note is host text: a model reply is that distillation.
    md = "\n".join(x for x in md.split("\n") if not x.strip().startswith(distill.PENDING_PREFIX))
    # Content guards: schema echoes, identity, stale claims (rule ids / kinds counted, never values).
    gt = guards.new_tally()
    md, _ = guards.normalize_title(t, md)
    md, added = guards.ensure_superseded_heading(t, md, cur_body)
    if added:
        gt["content"]["superseded_heading_added"] += 1
    md, n = guards.strip_schema_body(md, cur_body)
    ents, n_obs = guards.strip_schema_observations(ents)
    if n or n_obs:
        gt["schema_output"].update({"body": n, "kg": n_obs})
    md, n = guards.identity_body(md, cur_body)
    facts, n_f = guards.identity_facts(facts)
    ents, c_id = guards.identity_entities(ents)
    if n:
        gt["identity"]["user_relabel"] += n
    if n_f:
        gt["identity"]["user_relabel_fact"] += n_f
    gt["identity"].update(c_id)
    md, s_drop, s_dem, _ = guards.stale_body(t, md, cur_body, stale)
    ents, e_drop, e_dem = guards.stale_entities(ents, stale)
    facts, f_drop = guards.stale_facts(facts, stale)
    gt["stale_output"].update(s_drop + e_drop + f_drop)
    gt["stale_demoted"].update(s_dem + e_dem)
    md, c_body = guards.content_body(t, md, cur_body, plans, new_scroll, stale)
    ents, c_ents = guards.content_entities(ents, plans)
    gt["content"].update(c_body + c_ents)
    md, bad_log = sc.drop_malformed_superseded(md, cur_body)
    if bad_log:
        gt["schema_output"]["malformed_superseded"] += len(bad_log)
    extra_rules = [hint] if hint else []
    md, echo = distill.strip_prompt_echo(md, [chunk, cur_body], cur_body, extra_rules)
    ents, echo_obs = distill.strip_echo_observations(ents, [chunk, cur_body], cur_body, extra_rules)
    # Earlier chunks' facts too: the whole-target check at the end tests the body against all of them.
    md, stale = sc.drop_stated_superseded(md, list(prior_facts) + list(facts))
    # A brand-new scroll supersedes nothing and a no-op fact changes nothing: neither is logged (the
    # facts above still cleaned a restated old value out of the body).
    facts, sup_c = guards.superseded_facts(facts, new_scroll)
    gt["content"].update({f"superseded_fact_{k}": v for k, v in sup_c.items()})
    md, pruned = sc.prune_superseded_log(md, facts, cur_body)
    md, demoted = distill.demote_one_off_locked(t, md, cur_body, lock_new=lock_new)
    md, relocked = distill.relock_existing(t, md, cur_body)
    ents, merged_n = guards.dedupe_entities(ents)
    if merged_n:
        gt["kg_merged"]["entities"] += merged_n
    tally = {"body": p_body, "facts": p_facts, "entities": p_ents}
    for where, c in tally.items():
        if c:
            what = "line(s)" if where == "body" else "fact(s)" if where == "facts" else "entit(y/ies) or observation(s)"
            warnings.append(f"{t.scroll_id}: privacy filter removed {sum(c.values())} {what} from the reply {where} ({privacy.summary(c)})")
    if demoted:
        to = Counter(h for _, h in demoted)
        warnings.append(f"{t.scroll_id}: never-lock moved {len(demoted)} new one-off / idea bullet(s) out of the locked section ({', '.join(f'## {h} x{n}' for h, n in sorted(to.items()))})")
    if relocked:
        to = Counter(relocked)
        warnings.append(f"{t.scroll_id}: never-lock put {len(relocked)} existing locked bullet(s) the reply had moved out back under their locked heading ({', '.join(f'## {h} x{n}' for h, n in sorted(to.items()))})")
    g_json = guards.tally_json(gt)
    if g_json:
        warnings.append(f"{t.scroll_id}: content guards removed or demoted {guards.tally_count(gt)} item(s) from the reply ({_guard_summary(g_json)})")
    if stats is not None:
        stats["privacy"] = tally
        stats["demoted"] = demoted
        stats["relocked"] = relocked
        stats["guards"] = gt
    if echo:
        warnings.append(f"{t.scroll_id}: {len(echo)} prompt-echo line(s) removed ({_snips(echo, known)})")
    if echo_obs:
        warnings.append(f"{t.scroll_id}: {len(echo_obs)} prompt-echo observation(s) removed")
    if stale:
        warnings.append(f"{t.scroll_id}: {len(stale)} superseded line(s) removed from the body ({_snips(stale, known)})")
    if pruned:
        warnings.append(f"{t.scroll_id}: {len(pruned)} unlogged ## {sc.SUPERSEDED} line(s) dropped ({_snips(pruned, known)})")
    return {**reply, "updated_markdown": md, "graph_entities_to_upsert": ents, "superseded_facts": facts}, warnings


def _guard_summary(g: Dict[str, Dict[str, int]]) -> str:
    return "; ".join(f"{k} " + ", ".join(f"{x} x{n}" for x, n in v.items()) for k, v in g.items())


def distill_target(llm, t: sc.Target, old: Optional[sc.Scroll], text: str, archive_id: str, now_iso: str, known: List[str], partial: Dict, budget: Dict[str, int], warnings: Optional[List[str]] = None, repairs: Optional[List[Dict[str, Any]]] = None, emit: Optional[Emit] = None, policy: Optional[privacy.Policy] = None, stats: Optional[Dict[str, Any]] = None, hint: str = "", lock_new: bool = True, keep_partial: bool = False,
                   stale: Optional[stale_claims.Policy] = None, plans: Optional[guards.PlanIndex] = None):
    """Fold every chunk of `text` into the scroll. Returns (reasons, merged, entities, warnings).

    `partial` (persisted in state) carries progress between runs so a multi-chunk target can finish
    under `--max-batches 1`. Raises BudgetSpent when the call budget runs out mid-target.
    Warnings go into the caller's `warnings` list as they happen, so a caller still has them when
    a later chunk raises (BudgetSpent / transport error).

    Each chunk gets at most one retry, and only with a spare call (the budget minus this target's
    later chunks and `budget["reserve"]`, the calls kept for later targets):
    - `repair`: a reply rejected for a model-fixable reason (`distill.repairable`: bad / missing
      keys, a superseded fact still stated, a dropped locked bullet, too large, not JSON, ...) is
      re-prompted with the exact errors (scrubbed, capped) and its own rejected reply as data. The
      repaired reply is validated as strictly as the first; a secret-like reply is never repaired.
    - `length`: a reply cut off at the token limit is asked again, shorter.
    - `soft_compress`: a valid reply over TARGET_BYTES is asked to compress; the first valid
      result is never lost.
    Every retry is recorded in `repairs` (and emitted as an NDJSON `repair` event) with its outcome.
    The reasons returned for a failed target are the first reply's.

    Tier-2 privacy (`policy`, default `privacy.default_policy()`): the current scroll (and any
    partial body carried between runs) is filtered BEFORE the model sees it and before any
    comparison, so a personal locked bullet leaves only as an explicit, counted privacy removal and
    a non-personal one is still protected by the locked no-silent-loss check. Every accepted reply
    is filtered too (`_prepare_reply`). `stats` (optional) receives {"privacy": tally (category
    counts per where), "demoted": n, "demoted_to": Counter}; NDJSON `privacy` / `never_lock` events
    carry the same counts (categories only, never values). Reply counts reach `stats` only when the
    target succeeds: a target that fails (or falls back to the extractive preview) reports what its
    result actually lost, while its NDJSON events still show every accepted chunk.

    `hint`: host text added to every prompt of this target (before any retry hint) and treated as a
    rule by the prompt-echo check. `lock_new=False`: a transient target, no new locked bullet.
    `keep_partial` (offload): when a chunk after at least one accepted chunk of THIS call fails (no
    valid reply after its retry, the call budget spent, or a transport error), the body of the last
    accepted chunk is kept and checked like a finished one; `stats["partial"]` then holds
    {accepted, chunks, failed_chunk, errors}. A first-chunk failure still fails the target.

    `stale` (default: the built-in stale-claims policy): the current scroll loses the claims of its
    `existing: true` rules BEFORE the model sees it and before any comparison (a dropped locked
    bullet is logged under ## Superseded Decisions; a contested one leaves the locked sections as
    "(unconfirmed)"); every reply then passes the content guards (`_prepare_reply`; `plans`: the
    batch's plan lines, a scroll with no prior version is a brand-new scroll for the Superseded
    hygiene). `stats["guards"]` receives their counts (rule ids / kinds only).
    """
    policy = policy or privacy.default_policy()
    stale = stale or stale_claims.default_policy()
    stats = {} if stats is None else stats
    tally = stats.setdefault("privacy", privacy.new_tally())
    g_tally = stats.setdefault("guards", guards.new_tally())
    stats.setdefault("demoted", 0)
    stats.setdefault("demoted_to", Counter())
    warnings = [] if warnings is None else warnings
    repairs = [] if repairs is None else repairs
    new_scroll = old is None
    old, c_old, lk_old = privacy.filter_scroll_ex(old, policy)
    pf = privacy.filter_body_ex(partial.get("body") or "", policy)
    pbody, c_part = pf.body, pf.counts
    locked_gone = lk_old + pf.locked
    p_ents, c_pe = privacy.filter_entities(partial.get("entities") or [], policy)
    p_facts, c_pf = privacy.filter_facts(partial.get("facts") or [], policy)
    cur = c_old + c_part + c_pe + c_pf
    if cur:
        tally["current_scroll"].update(cur)
        warnings.append(f"{t.scroll_id}: privacy filter removed {sum(cur.values())} item(s) from the current scroll ({privacy.summary(cur)}); explicit privacy removal, the locked check compares against the filtered scroll")
        if emit is not None:
            emit({"event": "privacy", "target": t.rel, "where": "current_scroll", "removed": dict(sorted(cur.items()))})
    if locked_gone:
        # A LOCKED decision is never folded silently into a category count: its own warning and
        # event name the locked heading, the action and the category (never the value).
        stats.setdefault("privacy_locked", []).extend(locked_gone)
        warnings.append(f"{t.scroll_id}: privacy filter removed or redacted {len(locked_gone)} LOCKED bullet(s) of the current scroll ({privacy.locked_summary(locked_gone)}); explicit privacy removal, the full text stays in scroll-history and the cold archive")
        if emit is not None:
            emit({"event": "privacy_locked", "target": t.rel, "where": "current_scroll", "removed": privacy.locked_json(locked_gone)})
    old, sd0, sm0, _ = guards.stale_current(t, old, stale, archive_id, now_iso[:10])
    if sd0 or sm0:
        g_tally["stale_current"].update(sd0 + sm0)
        warnings.append(f"{t.scroll_id}: stale-claims policy removed {sum(sd0.values())} and demoted {sum(sm0.values())} line(s) of the current scroll ({', '.join(sorted(set(sd0) | set(sm0)))}); removed locked bullets are logged under ## Superseded Decisions")
        if emit is not None:
            emit({"event": "stale_claims", "target": t.rel, "where": "current_scroll", "dropped": stale_claims.counts_json(sd0), "demoted": stale_claims.counts_json(sm0)})
    run_tally = privacy.new_tally()  # accepted replies of this call; merged into `stats` on success
    run_guards = guards.new_tally()
    run_demoted: Counter = Counter()
    run_relocked: Counter = Counter()
    kept_partial: Optional[Dict[str, Any]] = None
    chunks = distill.chunks(text)
    start = int(partial.get("next_chunk") or 0)
    body = pbody or (old.body if old else sc.template_body(t))
    entities: List[dict] = list(p_ents)
    facts: List[dict] = list(p_facts)
    today = now_iso[:10]
    model = getattr(llm, "model", "")
    # Per target: the frontmatter grows with source_archive_ids, so a fixed allowance would let a
    # reply that met the prompt budget still merge over TARGET_BYTES.
    body_budget = distill.body_budget(t, old, archive_id, now_iso)
    sub_name = f"projects/{t.slug}--detail.md" if t.slug else "(none: compress harder)"

    def record(rec: Dict[str, Any], outcome: str, result: Optional[List[str]] = None) -> None:
        rec["outcome"] = outcome
        if result:
            rec["result_errors"] = distill.repair_errors(result, known)
        repairs.append(rec)
        if emit is not None:
            emit({"event": "repair", **rec})

    for i in range(start, len(chunks)):
        working_old = old if i == 0 and not partial.get("body") else sc.Scroll(t.scroll_id, t.category, now_iso, max(1, old.version if old else 1), [], [], body)
        later = len(chunks) - i - 1
        extra = ""
        reasons: List[str] = []
        best = None  # (reply, merged size, warnings): the first valid result; a soft retry never loses it
        retry: Optional[Dict[str, Any]] = None  # the retry in flight (attempt 1)
        failure = ""  # keep_partial: why this chunk ended with no reply (budget / transport)
        can_keep = keep_partial and i > start

        def spare(later=later) -> int:
            return budget["max"] - budget["used"] - int(budget.get("reserve") or 0) - later

        def new_retry(kind: str, errs: List[str], i=i) -> Dict[str, Any]:
            return {"target": t.rel, "chunk": i + 1, "chunks": len(chunks), "kind": kind, "errors": distill.repair_errors(errs, known)}

        for attempt in range(2):
            if budget["used"] >= budget["max"]:
                if best is not None:
                    break
                if can_keep:
                    failure = "LLM call budget spent"
                    break
                raise BudgetSpent()
            budget["used"] += 1
            msgs = distill.build_messages(t, [t.rel], archive_id, today, body, chunks[i], model, known, "\n".join(x for x in (hint, extra) if x), body_budget, policy)
            try:
                raw = llm.chat(msgs)
            except Exception as e:
                if retry is not None:
                    record(retry, "error")
                if best is None:
                    if can_keep:
                        failure = short_error(e)
                        break
                    raise
                warnings.append(f"{t.scroll_id}: compress retry failed ({short_error(e)}); kept the first reply")
                break
            if getattr(llm, "last_finish", None) == "length":
                cut = ["reply cut off at the token limit (finish_reason length)"]
                if attempt == 0:
                    reasons = cut
                    rec = new_retry("length", cut)
                    if spare() >= 1:
                        extra = distill.LENGTH_HINT.format(budget=body_budget)
                        retry = rec
                        continue
                    record(rec, "skipped_no_budget")
                    break
                if best is None:
                    record(retry, "cut_off", cut)
                else:
                    record(retry, "kept_first", cut)
                    warnings.append(f"{t.scroll_id}: compress retry cut off at the token limit; kept the first reply")
                break
            parsed = distill.parse_reply(raw)
            cand, cw, merged, pst = None, [], None, {}
            if parsed is None:
                r = ["reply was not a JSON object"]
            elif _has_secret(parsed, known):
                r = [SECRET_IN_REPLY]
            else:
                cand, cw = _prepare_reply(t, parsed, chunks[i], body, known, facts, policy, pst, lock_new, hint, stale, new_scroll, plans)
                r, merged, _ = sc.validate(t, working_old, cand, [t.rel], archive_id, now_iso, known)
            if r:
                if attempt == 1:
                    if best is not None:
                        record(retry, "kept_first", r)
                        what = "was not JSON" if parsed is None else f"invalid ({sc.one_line(r[0], 80)})"
                        warnings.append(f"{t.scroll_id}: compress retry {what}; kept the first reply")
                    else:
                        record(retry, "rejected", r)
                        warnings.append(f"{t.scroll_id}: repair of chunk {i + 1}/{len(chunks)} rejected ({sc.one_line(scrub.scrub(r[0], known), 80)})")
                    break
                if SECRET_IN_REPLY not in r and _has_secret(raw, known):
                    # The RAW reply too, not only its JSON: prose around (or instead of) the object
                    # holding a secret-like value is never repaired, so never echoed to the model.
                    r = [SECRET_IN_REPLY] if parsed is None else r + [SECRET_IN_REPLY]
                reasons = r
                if distill.repairable(r):
                    rec = new_retry("repair", r)
                    if spare() >= 1:
                        extra = distill.repair_hint(r, known, raw, body_budget, sub_name)
                        retry = rec
                        continue
                    record(rec, "skipped_no_budget")
                    warnings.append(f"{t.scroll_id}: no spare LLM call to repair chunk {i + 1}/{len(chunks)}")
                break
            size = sc.size_of(merged)
            if best is not None:
                if size < best[1]:
                    warnings.append(f"{t.scroll_id}: compress retry accepted ({best[1]} -> {size} bytes)")
                    best = (cand, size, cw, pst)
                    record(retry, "accepted")
                else:
                    warnings.append(f"{t.scroll_id}: compress retry not smaller ({size} bytes); kept the first reply")
                    record(retry, "kept_first")
                break
            best, reasons = (cand, size, cw, pst), []
            if retry is not None:
                record(retry, "accepted")
                warnings.append(f"{t.scroll_id}: {retry['kind']} retry of chunk {i + 1}/{len(chunks)} accepted")
                break
            # Soft compress: valid but over the target, on the LAST chunk only (an earlier chunk's
            # body is rewritten by the next one anyway, and the spare call must stay free for a
            # later chunk's repair), and a call to spare (`reserve`d calls for later targets come
            # first). The hint asks for what
            # would actually fit: TARGET_BYTES minus this reply's real overhead (frontmatter and
            # host-appended log), so it never asks for a size the reply already met.
            md_bytes = len(cand["updated_markdown"].encode("utf-8"))
            want = sc.TARGET_BYTES - (size - md_bytes)
            if attempt == 0 and later == 0 and size > sc.TARGET_BYTES and want >= distill.MIN_BODY_BUDGET and spare() >= 1:
                extra = distill.SOFT_COMPRESS_HINT.format(size=md_bytes, budget=want)
                retry = new_retry("soft_compress", [f"{size} bytes, over the {sc.TARGET_BYTES}-byte target"])
                continue
            break
        if best is None:
            if can_keep:
                errs = distill.repair_errors(reasons, known) if reasons else [scrub.scrub(failure or "no valid reply", known)]
                kept_partial = {"accepted": i - start, "chunks": len(chunks), "failed_chunk": i + 1, "errors": errs}
                why = sc.one_line(errs[0], 80) if errs else "no valid reply"
                warnings.append(f"{t.scroll_id}: chunk {i + 1}/{len(chunks)} failed ({why}); kept the model body of chunk(s) {start + 1}..{i}")
                if emit is not None:
                    emit({"event": "partial_distillation", "target": t.rel, "accepted": i - start, "chunks": len(chunks), "failed_chunk": i + 1})
                break
            return reasons, None, [], warnings
        reply, _, cw, pst = best
        warnings += cw
        privacy.add_tally(run_tally, pst.get("privacy") or {})
        guards.add_tally(run_guards, pst.get("guards") or {})
        demoted = pst.get("demoted") or []
        run_demoted.update(h for _, h in demoted)
        run_relocked.update(pst.get("relocked") or [])
        if emit is not None:
            removed = privacy.tally_json(pst.get("privacy") or {})
            if removed:
                emit({"event": "privacy", "target": t.rel, "chunk": i + 1, "where": "reply", "removed": removed})
            if demoted:
                emit({"event": "never_lock", "target": t.rel, "chunk": i + 1, "demoted": len(demoted), "to": dict(sorted(Counter(h for _, h in demoted).items()))})
            if pst.get("relocked"):
                emit({"event": "never_lock_relock", "target": t.rel, "chunk": i + 1, "relocked": len(pst["relocked"]), "to": dict(sorted(Counter(pst["relocked"]).items()))})
            g_json = guards.tally_json(pst.get("guards") or {})
            if g_json:
                emit({"event": "guards", "target": t.rel, "chunk": i + 1, "where": "reply", "removed": g_json})
        body, _ = sc.strip_body_frontmatter(t, reply["updated_markdown"])
        body = sc.enforce_superseded(body, reply["superseded_facts"], archive_id, today)
        entities, merged_n = guards.dedupe_entities(entities + reply["graph_entities_to_upsert"])
        if merged_n:
            run_guards["kg_merged"]["entities"] += merged_n
        facts += reply["superseded_facts"]
        partial.update({"next_chunk": i + 1, "body": body, "entities": entities[-MAX_ENTITIES:], "facts": facts[-10:]})
        budget["save"]()
    # A stale claim the host removed from the current scroll stays logged, even when a reply left
    # its ## Superseded Decisions line out (never a silent loss).
    stale_log = [x for x in sc.section_bullets(old.body if old is not None else "", [sc.SUPERSEDED]) if guards.STALE_LOG_MARK in x]
    if stale_log:
        body, _ = sc.keep_log_lines(body, stale_log, archive_id, today)
    errs = sc.body_errors(t, old, body, facts, entities, known, sub_scrolls=bool(old and sc.SUB_SCROLLS in sc.h2_list(old.body)))
    if errs:
        return errs, None, [], warnings
    merged, _ = sc.merge(t, old, body, facts, archive_id, now_iso)
    size = sc.size_of(merged)
    if size > sc.HARD_CAP_BYTES:
        return [f"{sc.TOO_LARGE}: {size} bytes > {sc.HARD_CAP_BYTES}"], None, [], warnings
    if size > sc.TARGET_BYTES:
        warnings.append(f"{t.scroll_id} is {size} bytes (target {sc.TARGET_BYTES})")
    privacy.add_tally(tally, run_tally)
    guards.add_tally(g_tally, run_guards)
    stats["demoted"] += sum(run_demoted.values())
    stats["demoted_to"].update(run_demoted)
    stats["relocked"] = int(stats.get("relocked") or 0) + sum(run_relocked.values())
    if kept_partial is not None:
        stats["partial"] = kept_partial
    return [], merged, entities[-MAX_ENTITIES:], warnings


# ── run ─────────────────────────────────────────────────────────────────────


def _pending_archives(st: Dict) -> List[str]:
    return sorted(aid for aid, e in (st.get("archives") or {}).items() if e.get("status") != "distilled")


def _kg(paths, rel: str, scroll_id: str, entities: List[dict], policy: Optional[privacy.Policy] = None, stale: Optional[stale_claims.Policy] = None) -> int:
    # Defence in depth: entities queued by an older run (before the privacy filter or the content
    # guards) are filtered too.
    entities, _ = privacy.filter_entities(entities, policy)
    entities, _ = guards.identity_entities(entities)
    entities, _, _ = guards.stale_entities(entities, stale)
    entities, _ = guards.strip_schema_observations(entities)
    ents, rels = graph.scroll_graph(scroll_id, rel, entities)
    stats = graph.kg_upsert(paths.kg_path, ents, rels)
    return stats["entities_added"] + stats["observations_added"]


def run(paths, opts: CompactOptions, env, emit: Emit) -> Dict[str, Any]:
    """Raises Deferred (exit 75) / ConfigError (2) / ArchiveError (1). Returns the result dict."""
    config.refuse_write_targets(paths)
    if opts.dry_run:
        return dry_run(paths, opts, env, emit)
    lock = ProcessLock(Path(paths.state_dir) / "compact.lock").acquire()
    try:
        return _run(paths, opts, env, emit)
    finally:
        lock.release()


def _run(paths, opts: CompactOptions, env, emit: Emit) -> Dict[str, Any]:
    now = _now(opts)
    now_iso = now.isoformat(timespec="seconds")
    st = state.load(paths.state_dir)
    save = lambda: state.save(paths.state_dir, st)  # noqa: E731
    key = keys.allm_key(env, paths.providers_json)
    known = scrub.known_values(paths.dotenv, env, [key])
    trace = RequestTrace()
    writer = sync.make_writer(paths.allm_base, key, paths.allm_workspace, trace)
    warnings: List[str] = list(paths.warnings)
    from .offload import effective_privacy  # lazy: offload imports this module

    policy, _ = effective_privacy(paths, env)
    warnings += list(policy.warnings)
    stale = stale_claims.load(paths.state_dir)
    warnings += list(stale.warnings)
    p_tally = privacy.new_tally()
    g_tally = guards.new_tally()
    demoted_total = 0
    relocked_total = 0
    locked_gone: List = []

    _phase(emit, "preflight")
    try:
        sync.reconcile(writer, st, save)
    except Exception as e:
        warnings.append(f"sync reconcile: {short_error(e)}")
    if opts.llm is not None:
        llm = opts.llm
    elif opts.replay_llm:
        llm = lmstudio.ReplayLLM.from_file(opts.replay_llm)
    else:
        reason = lmstudio.busy_reason(env, paths.gateway_base, opts.assume_idle)
        if reason:
            raise Deferred(reason)
        model = lmstudio.loaded_chat_model(paths.lm_base)
        if not model:
            raise Deferred("no chat model is loaded in LM Studio (never JIT-loading one)")
        llm = lmstudio.LiveLLM(paths.lm_base, model)
    llm_mode = getattr(llm, "mode", "live")

    kg_count = 0
    if st.get("kg_pending"):
        left = []
        for item in st["kg_pending"]:
            try:
                kg_count += _kg(paths, item["rel"], item["scroll_id"], item.get("entities") or [], policy, stale)
            except Deferred:
                left.append(item)
            except Exception as e:  # e.g. an OSError on the rename: keep it for the next run
                warnings.append(f"knowledge graph: {short_error(e)}")
                left.append(item)
        st["kg_pending"] = left
        save()

    _phase(emit, "collect")
    records, new_wm, notes = sources.collect(paths, st["watermarks"], known, opts.include_training_logs, opts.include_gateway_chat)

    _phase(emit, "archive")
    new_ids: List[str] = []
    if records:
        refs = archive.write_archive(paths.archive_root, records, {"kind": "buffer"}, now, known)
        if not (st.get("archive_root") or {}).get("pinned"):
            st["archive_root"] = {"pinned": str(paths.archive_root), "pinned_at": now_iso}
        st["watermarks"] = new_wm
        for ref in refs:
            _, recs = archive.read_entry(paths.archive_root, ref.archive_id)
            targets = sorted(distill.group(recs).keys())
            st.setdefault("archives", {})[ref.archive_id] = {"status": "archived", "records": ref.records, "created_at": ref.created_at, "targets": {t: "pending" for t in targets}, "attempts": {}, "partial": {}}
            new_ids.append(ref.archive_id)
        save()

    _phase(emit, "distill")
    budget = {"used": 0, "max": max(0, int(opts.max_batches)), "save": save}
    changed: List[str] = []
    repairs: List[Dict[str, Any]] = []
    updated: List[Dict[str, Any]] = []
    stop = False
    for aid in _pending_archives(st):
        if stop:
            break
        entry = st["archives"][aid]
        try:
            _, recs = archive.read_entry(paths.archive_root, aid)
        except (OSError, ValueError, ArchiveError) as e:
            warnings.append(f"{aid}: archive unreadable ({type(e).__name__})")
            continue
        groups = distill.group(recs)
        for rel in sorted(entry["targets"]):
            if entry["targets"][rel] != "pending":
                continue
            t = sc.target_info(rel)
            sg = guards.SourceGuard(stale)
            text = distill.batch_text(groups.get(rel, []), aid, known, guard=sg)
            # A project batch with no authoritative source (chats / threads / training logs only)
            # adds no NEW locked bullet (never-lock hardening).
            lock_new = t.kind != "project" or distill.lock_sources_ok(groups.get(rel, []))
            if not text.strip():
                entry["targets"][rel] = "done"
                save()
                continue
            try:
                old = sc.read_scroll(paths.scrolls_root, rel)
            except (ScrollError, OSError, UnicodeDecodeError) as e:
                entry["targets"][rel] = "failed"
                state.add_error(st, now_iso, f"{aid}:{rel}", f"current scroll unreadable: {e}")
                save()
                continue
            if old is not None and aid in old.source_archive_ids:
                entry["targets"][rel] = "done"
                save()
                continue
            partial = entry.setdefault("partial", {}).setdefault(rel, {})
            _phase(emit, "distill")
            tw: List[str] = []
            tstats: Dict[str, Any] = {"guards": guards.new_tally()}
            tstats["guards"]["stale_source"].update(sg.stale)
            if sg.schema:
                tstats["guards"]["schema_source"]["lines"] += sg.schema
            try:
                reasons, merged, entities, _ = distill_target(llm, t, old, text, aid, now_iso, known, partial, budget, tw, repairs, emit, policy, tstats, lock_new=lock_new, stale=stale)
            except BudgetSpent:
                warnings += tw
                stop = True
                break
            except Exception as e:  # transport trouble: keep pending, stop this run
                warnings += tw
                warnings.append(f"distill {rel}: {short_error(e)}")
                stop = True
                break
            warnings += tw
            privacy.add_tally(p_tally, tstats.get("privacy") or {})
            guards.add_tally(g_tally, tstats.get("guards") or {})
            demoted_total += int(tstats.get("demoted") or 0)
            relocked_total += int(tstats.get("relocked") or 0)
            locked_gone += tstats.get("privacy_locked") or []
            if reasons:
                entry.setdefault("attempts", {})[rel] = int(entry["attempts"].get(rel, 0)) + 1
                entry["partial"].pop(rel, None)
                if entry["attempts"][rel] >= MAX_ATTEMPTS:
                    entry["targets"][rel] = "failed"
                state.add_error(st, now_iso, f"{aid}:{rel}", "; ".join(reasons))
                save()
                continue
            _phase(emit, "write")
            # Intent first (kill / crash safe): the sync ledger marks the scroll dirty and the KG
            # upsert is queued BEFORE the write, so a run that dies after the write still syncs
            # the scroll and upserts its entities on the next run (whose archive-id guard then
            # skips the target without re-distilling it).
            kg_item = {"rel": rel, "scroll_id": t.scroll_id, "entities": entities}
            sync.mark_dirty(st, t.scroll_id, rel)
            st["kg_pending"] = (list(st.get("kg_pending") or []) + [kg_item])[-MAX_KG_PENDING:]
            save()
            try:
                write_scroll(paths.scrolls_root, rel, merged, paths.history_dir)
            except BaseException:
                st["kg_pending"] = [x for x in st.get("kg_pending") or [] if x is not kg_item]
                save()
                raise
            try:
                kg_count += _kg(paths, rel, t.scroll_id, entities, policy, stale)
                st["kg_pending"] = [x for x in st.get("kg_pending") or [] if x is not kg_item]
            except Deferred as e:
                warnings.append(f"knowledge graph deferred: {e}")
            except Exception as e:  # stays queued for the next run
                warnings.append(f"knowledge graph: {short_error(e)}")
            entry["targets"][rel] = "done"
            entry["partial"].pop(rel, None)
            changed.append(rel)
            updated.append({"id": merged.scroll_id, "version": merged.version, "bytes": sc.size_of(merged)})
            save()
        if all(v != "pending" for v in entry["targets"].values()):
            entry["status"] = "distilled"
            entry.pop("partial", None)
            save()

    _phase(emit, "sync")
    synced = sync.sync_changed(writer, st, paths.scrolls_root, changed, save, policy)
    if synced.get("privacy"):
        privacy.add_tally(p_tally, {"body": Counter(synced["privacy"])})
        warnings.append(f"sync: privacy filter removed {sum(synced['privacy'].values())} line(s) from scrolls before embedding ({privacy.summary(Counter(synced['privacy']))})")
    if writer is None and changed:
        warnings.append("no AnythingLLM key: scrolls written, sync pending")
    pending_targets = sum(1 for e in st["archives"].values() for v in e["targets"].values() if v == "pending")
    result = {
        "archive_ids": new_ids,
        "scrolls_updated": updated,
        "kg_entities_upserted": kg_count,
        "synced": synced["synced"],
        "sync_pending": synced["pending"],
        "sync_failed": synced["failed"],
        "pending_targets": pending_targets,
        "llm_calls": budget["used"],
        "repairs": [{k: v for k, v in r.items() if k != "errors"} for r in repairs],
        "sources": notes,
        "warnings": warnings,
        "llm": llm_mode,
        "privacy": {"policy_version": policy.version, "policy_sha": policy.sha, "removed": privacy.tally_json(p_tally), "locked_removed": privacy.locked_json(locked_gone)},
        "never_lock_demoted": demoted_total,
        "never_lock_relocked": relocked_total,
        "guards": {"version": guards.GUARDS_VERSION, "stale_claims": {"version": stale.version, "sha": stale.sha}, "removed": guards.tally_json(g_tally)},
    }
    st["last_run"] = {"at": now_iso, "archive_ids": new_ids, "scrolls_updated": len(updated), "llm": llm_mode, "pending_targets": pending_targets}
    save()
    _phase(emit, "done")
    return scrub.scrub_obj(result, known)


def dry_run(paths, opts: CompactOptions, env, emit: Emit) -> Dict[str, Any]:
    """Collect and report; writes nothing anywhere (no lock, no state, no archive, no LM call)."""
    try:
        st = state.load(paths.state_dir)
    except (OSError, ValueError):
        st = state.default()
    known = scrub.known_values(paths.dotenv, env, [keys.allm_key(env, paths.providers_json)])
    _phase(emit, "collect")
    records, _, notes = sources.collect(paths, st["watermarks"], known, opts.include_training_logs, opts.include_gateway_chat)
    batches = archive.split_batches(records)
    plan = []
    for i, b in enumerate(batches):
        groups = distill.group(b)
        plan.append({
            "archive": f"(new #{i + 1})",
            "records": len(b),
            "bytes_raw": sum(len(r["text"].encode("utf-8")) for r in b),
            "targets": {rel: len(v) for rel, v in sorted(groups.items())},
        })
    model = lmstudio.loaded_chat_model(paths.lm_base) if not opts.replay_llm else "replay"
    busy = None if opts.replay_llm else lmstudio.busy_reason(env, paths.gateway_base, opts.assume_idle)
    result = {
        "dry_run": True,
        "would_archive": plan,
        "pending": sources.pending(records),
        "undistilled": _pending_archives(st),
        "archive_root": str(paths.archive_root),
        "archive_root_source": paths.archive_root_source,
        "sources": notes,
        "lm": {"loaded_model": model, "busy": busy},
        "llm": "skipped",
        "warnings": list(paths.warnings),
    }
    _phase(emit, "done")
    return scrub.scrub_obj(result, known)


def status(paths, env) -> Dict[str, Any]:
    """Read-only summary for the Settings card and the host's auto-compaction check."""
    try:
        st = state.load(paths.state_dir)
    except (OSError, ValueError):
        st = state.default()
    known = scrub.known_values(paths.dotenv, env, [keys.allm_key(env, paths.providers_json)])
    records, _, _ = sources.collect(paths, st["watermarks"], known)
    pend = sources.pending(records)
    kb, turns = paths.thresholds
    scrolls = []
    for rel, s, size in sc.list_scrolls(paths.scrolls_root):
        scrolls.append({"id": s.scroll_id if s else None, "rel": rel, "version": s.version if s else None, "bytes": size, "valid": s is not None})
    unsynced = sorted(sid for sid, e in (st.get("sync") or {}).items() if e.get("state") != "synced" or e.get("dirty"))
    result = {
        "pending": pend,
        "threshold": {"kb": kb, "turns": turns},
        "threshold_hit": pend["bytes"] >= kb * 1024 or pend["turns"] >= turns,
        "archive_root": str(paths.archive_root),
        "archive_root_source": paths.archive_root_source,
        "pinned": (st.get("archive_root") or {}).get("pinned"),
        "scrolls_root": str(paths.scrolls_root),
        "scrolls": scrolls,
        "undistilled": _pending_archives(st),
        "unsynced": unsynced,
        "last_run": st.get("last_run"),
        "last_errors": (st.get("last_errors") or [])[-5:],
        "lm": {"loaded_model": lmstudio.loaded_chat_model(paths.lm_base, timeout=3.0)},
        "warnings": list(paths.warnings),
    }
    return scrub.scrub_obj(result, known)
