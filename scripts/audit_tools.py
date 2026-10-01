import argparse
import collections
import csv
import datetime as dt
import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path
from execution_evidence import PROCESS_FAILURES, action_hash, assessment, execution_evidence, merge_meta, merge_recorded_execution, recovery_match, valid_code


VERSION = 2
TERMINAL = {"completed", "failed"}
ERROR_PATTERNS = [
    ("invalid_arguments", r"invalid.*(?:argument|parameter)|validation error|required.*field|unexpected.*argument"),
    ("permission_denied", r"permission denied|unauthorized|forbidden|not authenticated"),
    ("timeout", r"timed out|timeout"),
    ("rate_limit", r"rate.limit|too many requests|\b429\b"),
    ("edit_match", r"not unique|multiple matches|old_string"),
    ("not_found", r"not found|no such file|does not exist"),
    ("cancelled", r"cancelled|canceled|interrupted"),
    ("network", r"connection refused|connection reset|ENOTFOUND"),
    ("nonzero_exit", r"(?:exit code|exited with (?:code|status))\s*[:=]?\s*[1-9][0-9]*\b"),
]
LIMITATIONS = [
    "Findings are review candidates, not proof of wasted work or agent mistakes. Expected test/search failures count as failed calls too.",
    "Observed ACP durations include adapter/queue overhead. Built-in MCP handler durations are separate; their sums are not wall-clock time.",
    "Recovery candidates require the same known turn/branch/agent plus command, process-completion, affected-target or corrected-action evidence within 10 calls and 600 seconds. Known task/cwd conflicts are rejected. Candidates do not establish task success.",
    "ACP status, transport outcome and process outcome are separate. Missing structured fields stay unknown; negative exit sentinels are not process failures, and background wait deadlines are not process-kill timeouts. Process outcome describes evidence at that call, not whether a process was still alive when the database was exported.",
    "Expected diagnostic failures require explicit expected exit codes from declared metadata or snapshot-bound human labels. A test command name or nonzero exit alone never establishes agent error or diagnostic intent.",
    "Historical model is unknown until a model-change or turn-context event. Current session settings are never backfilled into history.",
    "Fork prefixes are deduplicated only using recorded lineage plus matching call ID, start time, name and arguments. All source references are retained.",
    "Sequence detectors require non-overlapping calls; hidden/unmarked subagents and unrecorded external activity can still confound them.",
    "Output bytes are serialized payload bytes, not tokens. Image/base64 payloads cannot be priced as text.",
    "LLM coverage may be partial/provider-specific. Request truncation refers to saved bodies, not necessarily summary fields or fingerprint coverage.",
    "Configured-instruction hashes cover Sessionboxer instructions/briefing, not all provider or repository prompts. Inspector hashes cover the actual system/tools request fields.",
    "Verification outcomes are agent-reported evidence, not independent ground truth. A normally ended turn is not labelled successful.",
    "Reports exclude arguments, conversation text, raw output, error messages and session titles; IDs and aggregate metadata still require care when sharing.",
]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def obj(value):
    return value if isinstance(value, dict) else {}


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def timestamp(value):
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, AttributeError):
        return None


def elapsed(start, end):
    a, b = timestamp(start), timestamp(end)
    return round((b - a) * 1000, 3) if a is not None and b is not None and b >= a else None


def percentile(values, fraction):
    values = sorted(v for v in values if numeric(v))
    return round(values[max(0, math.ceil(len(values) * fraction) - 1)], 3) if values else None


def tool_name(update):
    meta = obj(update.get("_meta"))
    name = update.get("name") or obj(meta.get("claudeCode")).get("toolName") or meta.get("cognition.ai/inferenceToolName")
    return name if isinstance(name, str) and re.fullmatch(r"[\w.:/\-]{1,180}", name) else None


def output_info(value):
    texts, types = [], collections.Counter()
    is_error = False
    measurement = {}

    def walk(item, depth=0):
        nonlocal is_error, measurement
        if depth > 12:
            return
        if isinstance(item, str):
            if len(texts) < 100:
                texts.append(item[:32768])
            return
        if isinstance(item, list):
            for entry in item:
                walk(entry, depth + 1)
        if isinstance(item, dict):
            is_error |= item.get("isError") is True
            if obj(item.get("_meta")).get("sessionboxer/telemetry"):
                measurement = obj(item["_meta"]["sessionboxer/telemetry"])
            kind = item.get("type")
            if kind in ("text", "image", "resource", "resource_link", "audio"):
                types[kind] += 1
            if kind == "text":
                walk(item.get("text"), depth + 1)
            for key in ("content", "output", "result", "error", "message"):
                if key in item:
                    walk(item[key], depth + 1)

    walk(value)
    text = "\n".join(texts)[:100000]
    signals = [name for name, pattern in ERROR_PATTERNS if re.search(pattern, text, re.I)]
    return {
        "output_bytes": len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()),
        "images": types["image"], "result_is_error": is_error,
        "error_signals": signals, "measurement": measurement,
    }


def reference(call):
    return {"session_id": call["session_id"], "branch_id": call["branch_id"], "start_seq": call["start_seq"], "end_seq": call["end_seq"], "tool_call_id": call["tool_call_id"]}


def failure_evidence(call):
    execution = call.get("execution", {})
    if execution.get("processOutcome") in PROCESS_FAILURES:
        return "structured_process_failure"
    if execution.get("transportOutcome") == "failed":
        return "structured_transport_failure"
    if call["status"] == "failed":
        return "acp_failed"
    if call["result_is_error"]:
        return "result_is_error"
    if call.get("measured_error"):
        return "measured_tool_error"
    if execution.get("processOutcome", "unknown") == "unknown" and "nonzero_exit" in call["error_signals"]:
        return "nonzero_exit_text"
    return None


def comparable(a, b, seconds=600):
    gap = elapsed(a["ended_at"], b["started_at"])
    return gap is not None and gap <= seconds * 1000


def review_key(ref):
    if not isinstance(ref, dict) or not isinstance(ref.get("session_id"), str) or type(ref.get("start_seq")) is not int or not isinstance(ref.get("tool_call_id"), str):
        raise ValueError("Invalid review reference")
    return ref["session_id"], ref["start_seq"], ref["tool_call_id"]


def reviewed_calls(calls):
    return {review_key(ref): call for call in calls for ref in call["references"]}


def apply_reviews(calls, reviews, snapshot):
    if reviews is None:
        return
    if not isinstance(reviews, dict) or reviews.get("version") != 1 or reviews.get("snapshot_fingerprint") != snapshot:
        raise ValueError("Review labels do not match the database snapshot")
    if not isinstance(reviews.get("calls", []), list) or not isinstance(reviews.get("recovery_pairs", []), list):
        raise ValueError("Invalid review labels")
    lookup, seen = reviewed_calls(calls), set()
    for label in reviews.get("calls", []):
        key = review_key(label)
        if key not in lookup or key in seen:
            raise ValueError("Unknown or duplicate reviewed call")
        call = lookup[key]
        canonical_key = review_key(reference(call))
        if canonical_key in seen:
            raise ValueError("Duplicate labels for copied call history")
        seen.add(canonical_key)
        if "expected_exit_codes" in label:
            codes = label["expected_exit_codes"]
            if not isinstance(codes, list) or not 0 < len(codes) <= 32 or not all(valid_code(v) for v in codes):
                raise ValueError("Invalid diagnostic expectation")
            call["execution"]["expectedExitCodes"] = list(dict.fromkeys(codes))
            call["execution"]["diagnosticSource"] = "human_review"
        if "task_id" in label:
            if not isinstance(label["task_id"], str) or not 0 < len(label["task_id"]) <= 2048:
                raise ValueError("Invalid task label")
            call["execution"]["context"]["taskHash"] = digest(label["task_id"])


def validate_reviewed_pairs(calls, failures, reviews):
    lookup = reviewed_calls(calls)
    chosen = {review_key(f): f["candidate_reference"] for f in failures}
    counts, rows, seen = collections.Counter(), [], set()
    for pair in (reviews or {}).get("recovery_pairs", []):
        if not isinstance(pair, dict):
            raise ValueError("Invalid reviewed pair")
        source, target = review_key(pair.get("failure")), review_key(pair.get("candidate"))
        label = pair.get("label")
        if source not in lookup or target not in lookup or (source, target) in seen or label not in ("related_retry", "not_same_operation", "insufficient_evidence"):
            raise ValueError("Unknown or invalid reviewed pair")
        failure, candidate = lookup[source], lookup[target]
        canonical_pair = (review_key(reference(failure)), review_key(reference(candidate)))
        if canonical_pair in seen:
            raise ValueError("Duplicate reviewed pair in copied history")
        seen.add(canonical_pair)
        if not failure_evidence(failure):
            raise ValueError("Reviewed pair has no source failure signal")
        selected = chosen.get(review_key(reference(failure)))
        predicted = selected is not None and review_key(selected) == review_key(reference(candidate))
        verdict = "unscored" if label == "insufficient_evidence" else "true_related" if predicted and label == "related_retry" else "false_related" if predicted else "missed_related" if label == "related_retry" else "correct_rejection"
        counts[verdict] += 1
        rows.append({"failure": reference(failure), "candidate": reference(candidate), "label": label, "predicted_match": predicted, "verdict": verdict})
    return {"pairs": len(rows), "counts": dict(counts), "results": rows, "scope": "Targeted reviewed pairs, not a representative recovery-success estimate; pair labels do not influence matching."}


def audit(path, reviews=None):
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA trusted_schema=OFF")
    db.execute("BEGIN")
    try:
        return analyze(db, reviews)
    finally:
        db.close()


def analyze(db, reviews=None):
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"sessions", "events"} <= tables:
        raise ValueError("Expected Sessionboxer sessions and events tables")
    providers = dict(db.execute("SELECT id,provider FROM sessions ORDER BY id"))
    forks = {}
    for row in db.execute("SELECT session_id,seq,body FROM events WHERE CASE WHEN json_valid(body) THEN json_extract(body,'$.type') END='forked' ORDER BY seq"):
        body = json.loads(row["body"])
        if body.get("conversation") != "new" and body.get("fromSessionId"):
            forks[row["session_id"]] = (row["seq"], body["fromSessionId"])

    def origin(sid, seq):
        seen = set()
        while sid in forks and sid not in seen and seq < forks[sid][0]:
            seen.add(sid)
            sid = forks[sid][1]
        return sid

    occurrences, active, turns, state = [], {}, {}, {}
    llms, measurements = {}, {}
    counters = collections.Counter()
    snapshot = hashlib.sha256(json.dumps(providers, sort_keys=True).encode())
    first_ts, last_ts = None, None
    for row in db.execute("SELECT session_id,branch_id,seq,ts,body FROM events ORDER BY session_id,seq"):
        sid, branch, seq, ts, raw = tuple(row)
        branch = branch or "root"
        snapshot.update(json.dumps([sid, branch, seq, ts, raw], separators=(",", ":")).encode())
        counters["events"] += 1
        first_ts = min(first_ts or ts, ts)
        last_ts = max(last_ts or ts, ts)
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            counters["invalid_events"] += 1
            continue
        if not isinstance(body, dict):
            counters["invalid_events"] += 1
            continue
        typ = body.get("type")
        scope = (sid, branch)
        current = state.setdefault(scope, {"turn": 0, "model": None})
        turn_key = (sid, branch, current["turn"])
        if typ == "user_prompt":
            current["turn"] = seq
            turn_key = (sid, branch, seq)
            source = body.get("origin")
            turns[turn_key] = {"turn_id": body.get("turnId"), "kind": source if isinstance(source, str) else "agent" if isinstance(source, dict) else "user", "stop_reason": None, "end_seq": None, "context": {}}
        turn = turns.setdefault(turn_key, {"turn_id": None, "kind": "unknown", "stop_reason": None, "end_seq": None, "context": {}})
        if typ == "turn_context":
            turn["context"] = obj(body.get("context"))
            current["model"] = turn["context"].get("model")
        elif typ == "model_changed":
            current["model"] = body.get("model")
        elif typ in ("turn_ended", "agent_error"):
            turn["end_seq"] = seq
            turn["stop_reason"] = body.get("stopReason") if typ == "turn_ended" else "agent_error"
            current["turn"] = -seq
        elif typ == "llm_call":
            call = obj(body.get("call"))
            key = (origin(sid, seq), seq, call.get("id"))
            llms[key] = {"session_id": origin(sid, seq), "provider": providers.get(origin(sid, seq), providers.get(sid)), "model": call.get("model"), "usage": obj(call.get("usage")), "shape": obj(call.get("shape")), "request_truncated": call.get("requestTruncated") is True}
        elif typ == "mcp_execution":
            execution = obj(body.get("execution"))
            if execution.get("version") == 1:
                measurements[execution.get("executionId")] = execution
        elif typ == "tool_execution":
            execution = obj(body.get("execution"))
            target = active.get((sid, branch, execution.get("toolCallId")))
            if target is not None and execution.get("version") in (1, 2):
                target["telemetry"] = execution
        elif typ == "update":
            update = obj(body.get("update"))
            subtype = update.get("sessionUpdate")
            if subtype not in ("tool_call", "tool_call_update"):
                continue
            counters["tool_events"] += 1
            cid = update.get("toolCallId")
            if not isinstance(cid, str):
                counters["missing_call_ids"] += 1
                continue
            key = (sid, branch, cid)
            call = active.get(key)
            if call is None or (subtype == "tool_call" and call["status"] in TERMINAL):
                call = {"session_id": sid, "branch_id": branch, "tool_call_id": cid, "start_seq": seq, "end_seq": None, "started_at": ts if subtype == "tool_call" else None, "ended_at": None, "status": None, "tool": "unknown", "provider": providers.get(origin(sid, seq), providers.get(sid)), "model": current["model"], "turn_key": turn_key, "parent_agent": None, "input_hash": None, "requested_wait_s": None, "requested_timeout_ms": None, "output_bytes": 0, "images": 0, "result_is_error": False, "error_signals": [], "measurement": {}, "telemetry": {}, "args": {}, "meta": {}, "structured_output": {}, "locations": [], "updates": 0}
                active[key] = call
                occurrences.append(call)
            call["updates"] += 1
            name = tool_name(update)
            if name:
                call["tool"] = name
            call["meta"] = merge_meta(call["meta"], obj(update.get("_meta")))
            meta = call["meta"]
            call["structured_output"].update(obj(update.get("rawOutput")))
            if update.get("locations"):
                call["locations"] = update["locations"]
            agent_context = obj(meta.get("cognition.ai/subagent_context"))
            parent = agent_context.get("agentId") or agent_context.get("parentAgentId")
            if isinstance(parent, str):
                call["parent_agent"] = parent
            args = update.get("rawInput")
            if args is not None and (args != {} or call["input_hash"] is None):
                call["input_hash"] = digest(args)
                call["args"] = args
                duration = obj(args).get("duration")
                if numeric(duration):
                    call["requested_wait_s"] = duration
                timeout = obj(args).get("timeout")
                if numeric(timeout):
                    call["requested_timeout_ms"] = timeout
            output = update.get("rawOutput")
            if output is None:
                output = update.get("content") or None
            if output is not None:
                call.update(output_info(output))
            status = update.get("status")
            if status and call["status"] not in TERMINAL:
                call["status"] = status
                if status in TERMINAL:
                    call["end_seq"], call["ended_at"] = seq, ts

    grouped = collections.defaultdict(list)
    for call in occurrences:
        key = (origin(call["session_id"], call["start_seq"]), call["start_seq"], call["tool_call_id"], call["started_at"], call["tool"], call["input_hash"])
        grouped[key].append(call)
    calls = []
    for key, copies in grouped.items():
        call = min(copies, key=lambda c: (c["status"] not in TERMINAL, c["session_id"] != key[0], -c["updates"], c["session_id"]))
        call["references"] = [reference(c) for c in sorted(copies, key=lambda c: (c["session_id"], c["start_seq"]))]
        call["source_session_id"] = key[0]
        call["observed_ms"] = elapsed(call["started_at"], call["ended_at"])
        telemetry = call["telemetry"]
        if numeric(telemetry.get("observedDurationMs")):
            call["observed_ms"] = telemetry["observedDurationMs"]
        measured = {**call["measurement"], **telemetry}
        execution_id = measured.get("executionId")
        if execution_id in measurements:
            measured = {**measured, **measurements[execution_id]}
        call["execution_id"] = execution_id
        call["execution_ms"] = measured.get("executionMs") if numeric(measured.get("executionMs")) else None
        call["tool_schema_hash"] = measured.get("toolSchemaHash")
        call["execution"] = execution_evidence(call["tool"], call["args"], call["meta"], call["structured_output"], call["locations"])
        recorded = obj(telemetry.get("execution"))
        if telemetry.get("version") == 2 and recorded:
            call["execution"] = merge_recorded_execution(call["execution"], recorded, call["tool"])
        call["action_hash"] = action_hash(call["tool"], call["args"])
        measured_code = measured.get("errorCode")
        if not isinstance(measured_code, str) or measured_code not in {name for name, _ in ERROR_PATTERNS} | {"tool_error", "transport_error", "signalled"}:
            measured_code = None
        call["measured_error"] = measured_code is not None and not (measured.get("errorSource") == "heuristic" and call["execution"]["processOutcome"] in ("succeeded", "running"))
        process_error = PROCESS_FAILURES.get(call["execution"]["processOutcome"])
        transport_error = "transport_error" if call["execution"]["transportOutcome"] == "failed" else None
        call["error_code"], call["error_source"] = None, None
        if failure_evidence(call):
            text_error = call["error_signals"][0] if call["error_signals"] and call["execution"]["processOutcome"] != "succeeded" else None
            call["error_code"] = process_error or transport_error or (measured_code if call["measured_error"] else None) or text_error or "unclassified"
            call["error_source"] = "structured" if process_error or transport_error else "heuristic" if text_error else "provider_status"
        turn = turns[call["turn_key"]]
        call["turn_kind"] = turn["kind"]
        call["turn_stop_reason"] = turn["stop_reason"]
        call["turn_id"] = turn["turn_id"]
        call["turn_end_seq"] = turn["end_seq"]
        call["configured_instructions_hash"] = turn["context"].get("configuredInstructionsHash")
        calls.append(call)
    calls.sort(key=lambda c: (c["session_id"], c["start_seq"], c["tool_call_id"]))
    verification = verification_summary(db, tables)
    snapshot.update(json.dumps(verification, sort_keys=True).encode())
    apply_reviews(calls, reviews, snapshot.hexdigest())
    for call in calls:
        call["assessment"] = assessment(call, failure_evidence(call))
    leaderboard = []
    by_tool = collections.defaultdict(list)
    for call in calls:
        by_tool[(call["provider"], call["tool"])].append(call)
    for (provider, name), values in sorted(by_tool.items(), key=lambda x: (-len(x[1]), str(x[0]))):
        done = sum(c["status"] in TERMINAL for c in values)
        failed = sum(c["status"] == "failed" for c in values)
        leaderboard.append({"provider": provider, "tool": name, "calls": len(values), "completed": sum(c["status"] == "completed" for c in values), "failed": failed, "incomplete": len(values) - done, "failed_pct_of_terminal": round(failed * 100 / done, 2) if done else None, "observed_p50_ms": percentile([c["observed_ms"] for c in values], .5), "observed_p95_ms": percentile([c["observed_ms"] for c in values], .95), "output_bytes": sum(c["output_bytes"] for c in values), "image_results": sum(c["images"] > 0 for c in values), "completed_error_signals": sum(c["status"] == "completed" and failure_evidence(c) is not None for c in values)})
    failures, sequences = review_sequences(calls)
    review_validation = validate_reviewed_pairs(calls, failures, reviews)
    outcomes = collections.defaultdict(list)
    for run in verification["runs"]:
        outcomes[(run["session_id"], run["turn_end_seq"])].append(run["status"])
    for call in calls:
        call["verification_outcomes"] = outcomes[(call["source_session_id"], call["turn_end_seq"])]
    llm_groups = collections.defaultdict(list)
    for call in llms.values():
        llm_groups[call["provider"]].append(call)
    llm_summary = []
    for provider, values in sorted(llm_groups.items(), key=lambda x: str(x[0])):
        totals = collections.Counter()
        for value in values:
            totals.update({k: v for k, v in value["usage"].items() if k in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens") and numeric(v)})
        llm_summary.append({"provider": provider, "calls": len(values), "sessions": len({v["session_id"] for v in values}), "with_usage": sum(bool(v["usage"]) for v in values), "truncated_requests": sum(v["request_truncated"] for v in values), "with_prompt_hash": sum(bool(v["shape"].get("systemPromptHash")) for v in values), "with_schema_hash": sum(bool(v["shape"].get("toolSchemaHash")) for v in values), "recorded_token_totals": dict(totals)})
    mcp_groups = collections.defaultdict(list)
    for measurement in measurements.values():
        mcp_groups[(measurement.get("server"), measurement.get("toolName"))].append(measurement)
    mcp_summary = [{"server": server, "tool": name, "executions": len(values), "p50_execution_ms": percentile([v.get("executionMs") for v in values], .5), "p95_execution_ms": percentile([v.get("executionMs") for v in values], .95), "errors": sum(v.get("errorCode") is not None for v in values), "schema_versions": len({v.get("toolSchemaHash") for v in values})} for (server, name), values in sorted(mcp_groups.items(), key=lambda x: (-len(x[1]), str(x[0])))]
    public_fields = ["session_id", "source_session_id", "branch_id", "tool_call_id", "tool", "provider", "model", "start_seq", "end_seq", "started_at", "ended_at", "status", "observed_ms", "execution_id", "execution_ms", "tool_schema_hash", "configured_instructions_hash", "output_bytes", "images", "error_code", "error_source", "execution", "assessment", "turn_kind", "turn_id", "turn_end_seq", "turn_stop_reason", "verification_outcomes", "references"]
    summary = {"sessions": len(providers), "events": counters["events"], "invalid_events": counters["invalid_events"], "missing_call_ids": counters["missing_call_ids"], "tool_events": counters["tool_events"], "call_occurrences": len(occurrences), "copied_call_occurrences": len(occurrences) - len(calls), "calls": len(calls), "failed": sum(c["status"] == "failed" for c in calls), "incomplete": sum(c["status"] not in TERMINAL for c in calls), "orphan_calls": sum(c["started_at"] is None for c in calls), "model_known_calls": sum(c["model"] is not None for c in calls), "configured_prompt_hash_calls": sum(bool(c["configured_instructions_hash"]) for c in calls), "mcp_measurements": len(measurements), "mcp_measurements_linked": len({c["execution_id"] for c in calls if c["execution_id"] in measurements}), "failure_review_candidates": len(failures), "suspicious_sequences": len(sequences), "requested_wait_seconds": sum(c["requested_wait_s"] or 0 for c in calls if c["tool"].endswith("__wait")), "from": first_ts, "to": last_ts}
    summary.update({"structured_exit_calls": sum(c["execution"]["exitCode"] is not None for c in calls), "process_outcomes": dict(collections.Counter(c["execution"]["processOutcome"] for c in calls)), "transport_outcomes": dict(collections.Counter(c["execution"]["transportOutcome"] for c in calls)), "expected_diagnostic_failures": sum(c["assessment"] == "expected_diagnostic_failure" for c in calls), "diagnostic_assessments": dict(collections.Counter(c["assessment"] for c in calls if c["execution"]["expectedExitCodes"] is not None)), "evidence_matched_recovery_candidates": sum(f["candidate_reference"] is not None for f in failures)})
    return {"audit_version": VERSION, "review_validation": review_validation, "snapshot_fingerprint": snapshot.hexdigest(), "summary": summary, "limitations": LIMITATIONS, "leaderboard": leaderboard, "failures": failures, "sequences": sequences, "llm_coverage": llm_summary, "mcp_execution_leaderboard": mcp_summary, "verification": verification, "calls": [{key: c[key] for key in public_fields} for c in calls]}


def review_sequences(calls):
    failures, sequences = [], []
    groups = collections.defaultdict(list)
    for call in calls:
        groups[(call["turn_key"], call["parent_agent"])].append(call)

    def add(kind, score, items, reason):
        sequences.append({"kind": kind, "score": score, "confidence": "candidate", "calls": len(items), "session_id": items[0]["session_id"], "branch_id": items[0]["branch_id"], "start_seq": items[0]["start_seq"], "end_seq": items[-1]["end_seq"], "tools": [c["tool"] for c in items], "turn_kind": items[0]["turn_kind"], "reason": reason, "references": [reference(c) for c in items]})

    for values in groups.values():
        values.sort(key=lambda c: c["start_seq"])
        for i, call in enumerate(values):
            evidence = failure_evidence(call)
            if evidence:
                recovered = None
                if call["assessment"] != "expected_diagnostic_failure":
                    for j, candidate in enumerate(values[i + 1:i + 11], 1):
                        if not comparable(call, candidate) or failure_evidence(candidate):
                            continue
                        match = recovery_match(call, candidate)
                        if match and "same_process_completion" in match["reasons"]:
                            context = call["execution"]["context"]
                            reused = any(intervening["execution"]["context"]["commandHash"] not in (None, context["commandHash"]) and set(intervening["execution"]["context"]["processRefs"]) & set(context["processRefs"]) for intervening in values[i + 1:i + j])
                            if reused:
                                continue
                        if match:
                            recovered = (j, candidate, match)
                            break
                recovery = "not_required_expected_diagnostic" if call["assessment"] == "expected_diagnostic_failure" else "evidence_matched_candidate" if recovered else "not_observed"
                failures.append({**reference(call), "tool": call["tool"], "provider": call["provider"], "turn_kind": call["turn_kind"], "evidence": evidence, "error_code": call["error_code"], "error_source": call["error_source"], "error_signals": call["error_signals"], "execution": call["execution"], "assessment": call["assessment"], "recovery": recovery, "recovery_evidence": recovered[2] if recovered else None, "calls_until_candidate": recovered[0] if recovered else None, "candidate_reference": reference(recovered[1]) if recovered else None, "turn_stop_reason": call["turn_stop_reason"], "needs_human_review": call["assessment"] != "expected_diagnostic_failure"})
            if i == 0:
                continue
            prev = values[i - 1]
            if not comparable(prev, call, 120):
                continue
            same = prev["tool"] == call["tool"] and prev["input_hash"] is not None and prev["input_hash"] == call["input_hash"]
            if same and failure_evidence(prev) and prev["assessment"] != "expected_diagnostic_failure":
                add("unchanged_retry", 90, [prev, call], "Same tool and arguments immediately after an error signal; inspect whether the retry was justified.")
            elif same and call["tool"].lower() in ("read", "grep", "find_file_by_name", "toolsearch", "mcp_list_tools"):
                add("repeated_read_or_discovery", 40, [prev, call], "Identical adjacent read/discovery calls within 120 seconds; check for truncation or a changed external state.")
            if prev["tool"].endswith("__wait") and prev["images"] and call["tool"].endswith("__screenshot") and comparable(prev, call, 30):
                add("wait_then_screenshot", 50, [prev, call], "Wait already returned an image; screenshot followed within 30 seconds with no intervening recorded tool call.")
        run = []
        for call in values + [None]:
            poll = call is not None and (call["tool"].endswith("__wait") or call["tool"] == "get_output")
            continues = poll and (not run or (call["tool"] == run[-1]["tool"] and comparable(run[-1], call, 120) and (call["tool"].endswith("__wait") or call["input_hash"] == run[-1]["input_hash"])))
            if not continues:
                if len(run) >= 3:
                    if run[0]["tool"] == "get_output" and all((c["requested_timeout_ms"] or 0) >= 60_000 for c in run):
                        add("long_running_process_wait", 20, run, "Repeated reads already requested at least 60 seconds each. Low-priority tool/process-latency candidate, not evidence of short-polling misuse.")
                    else:
                        add("polling_run", min(85, 60 + len(run)), run, "At least three consecutive waits/polls; consider a readiness signal or longer blocking read, but verify the task needed no intermediate observations.")
                run = []
            if poll:
                run.append(call)
    sequences.sort(key=lambda row: (-row["score"], row["session_id"], row["start_seq"], row["kind"]))
    for rank, row in enumerate(sequences, 1):
        row["rank"] = rank
    return failures, sequences


def verification_summary(db, tables):
    if not {"e2e_runs", "e2e_cases"} <= tables:
        return {"available": False, "runs": []}
    runs = []
    for row in db.execute("SELECT id,session_id,turn_seq,status FROM e2e_runs ORDER BY session_id,turn_seq,id"):
        cases = list(db.execute("SELECT idx,cycle,status FROM e2e_cases WHERE run_id=? ORDER BY idx,cycle", (row["id"],)))
        latest = {case["idx"]: case["status"] for case in cases}
        runs.append({"run_id": row["id"], "session_id": row["session_id"], "turn_end_seq": row["turn_seq"], "status": row["status"], "attempts": len(cases), "failed_attempts": sum(c["status"] == "failed" for c in cases), "latest_case_statuses": dict(collections.Counter(latest.values()))})
    return {"available": True, "runs": runs}


def safe_cell(value):
    if isinstance(value, (dict, list)):
        value = json.dumps(value, sort_keys=True)
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


def markdown(report):
    summary = report["summary"]
    lines = ["# Sessionboxer tool-use audit", "", f"Audit version: {VERSION}. Snapshot fingerprint: `{report['snapshot_fingerprint']}`.", "", "## Coverage", ""]
    lines.extend(f"- **{key}**: {value}" for key, value in summary.items())
    lines += ["", "## Tool leaderboard", "", "Observed durations are ACP latency, not handler execution time. Full results are in leaderboard.csv.", "", "| Provider | Tool | Calls | ACP failed | Incomplete | p50 ms | p95 ms |", "|---|---|---:|---:|---:|---:|---:|"]
    for row in report["leaderboard"][:30]:
        lines.append("| " + " | ".join(str(row[k]) for k in ("provider", "tool", "calls", "failed", "incomplete", "observed_p50_ms", "observed_p95_ms")) + " |")
    errors = collections.Counter(r["error_code"] for r in report["failures"])
    recovery = collections.Counter(r["recovery"] for r in report["failures"])
    lines += ["", "## Failure and recovery review", "", f"Error categories (provenance is in each row's error_source): `{json.dumps(dict(errors), sort_keys=True)}`.", "", f"Recovery candidates: `{json.dumps(dict(recovery), sort_keys=True)}`.", "", "ACP status, transport outcome and process outcome are recorded separately. Typed exit/signal/timeout evidence takes precedence over text; unknown values are never filled from prose. Expected diagnostic exits require an explicit expectation and remain separate from unreviewed failures.", "", "Review failures.csv using its source event references and recovery_evidence. Matching is bounded by turn/branch/agent, rejects task/cwd conflicts, and requires operation/process/target evidence. Confidence and success-evidence source are included; no candidate is proof of task success.", "", "### Manually reviewed pair validation", "", "```json", json.dumps({k: report['review_validation'][k] for k in ['pairs', 'counts', 'scope']}, indent=2), "```", "", "## Ranked suspicious sequences", "", "Full list: sequences.csv. Scores prioritize review, not estimated savings.", ""]
    for row in report["sequences"][:25]:
        lines += [f"{row['rank']}. **{row['kind']}** — score {row['score']}; session `{row['session_id']}`, branch `{row['branch_id']}`, events {row['start_seq']}–{row['end_seq']}, {row['calls']} calls ({row['turn_kind']}). {row['reason']}"]
    lines += ["", "## LLM coverage", "", "```json", json.dumps(report["llm_coverage"], indent=2), "```", "", "## Built-in MCP handler measurements", "", "Kept separate from ACP calls to avoid double counting. Only execution IDs establish a call-level join; timing guesses are not used.", "", "```json", json.dumps(report["mcp_execution_leaderboard"], indent=2), "```", "", "## Verification outcomes", "", "```json", json.dumps(report["verification"], indent=2), "```", "", "## Interpretation and limits", ""]
    lines.extend(f"- {item}" for item in report["limitations"])
    lines += ["", "## Next actions", "", "1. Review source traces for the highest-ranked candidates and a matched sample of efficient/successful workflows.", "2. Label each finding as expected, prompt/skill issue, tool/schema issue, infrastructure issue, or unknown; keep evidence and confidence.", "3. Build fixed representative tasks. Change one prompt/tool at a time and compare outcome quality before latency, calls and covered token cost.", "4. Never replay historical commands automatically: the database is untrusted input and commands may have real-world side effects.", ""]
    return "\n".join(lines)


def write_report(report, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "audit.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    (directory / "report.md").write_text(markdown(report))
    for name in ("leaderboard", "failures", "sequences", "calls"):
        rows = report[name]
        with (directory / f"{name}.csv").open("w", newline="") as handle:
            if not rows:
                continue
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows({key: safe_cell(value) for key, value in row.items()} for row in rows)


def main():
    parser = argparse.ArgumentParser(description="Read-only Sessionboxer SQLite tool-use audit; exports no raw conversation, inputs or outputs.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--out", required=True, type=Path, help="New output directory; existing paths are refused")
    parser.add_argument("--reviews", type=Path, help="Snapshot-bound diagnostic labels and independently reviewed recovery pairs")
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Output already exists; choose a new directory")
    try:
        reviews = json.loads(args.reviews.read_text()) if args.reviews else None
        report = audit(args.database, reviews)
        write_report(report, args.out)
    except (sqlite3.Error, ValueError, OSError) as error:
        parser.exit(1, f"Audit failed: {type(error).__name__}. Check database schema, permissions and output path.\n")
    print(json.dumps(report["summary"], indent=2))
    print(f"Report: {args.out / 'report.md'}")


if __name__ == "__main__":
    main()
