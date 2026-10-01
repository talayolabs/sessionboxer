import hashlib
import json
import posixpath
import re


COMMAND_TOOLS = {"bash", "exec", "get_output", "taskoutput", "terminal_read", "mcp__sessionboxer__terminal_read"}
PROCESS_FAILURES = {"failed": "nonzero_exit", "signalled": "signalled", "timed_out": "timeout", "interrupted": "cancelled"}


def obj(value):
    return value if isinstance(value, dict) else {}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def valid_code(value):
    return type(value) is int and 0 <= value <= 0xffffffff


def text(value):
    return isinstance(value, str) and bool(value)


def merge_meta(previous, patch):
    merged = {**previous, **patch}
    for key in ("terminal_exit", "claudeCode", "sessionboxer/execution", "sessionboxer/diagnostic"):
        if key in previous or key in patch:
            merged[key] = {**obj(previous.get(key)), **obj(patch.get(key))}
    if "claudeCode" in merged:
        old = obj(obj(previous.get("claudeCode")).get("toolResponse"))
        new = obj(obj(patch.get("claudeCode")).get("toolResponse"))
        if old or new:
            merged["claudeCode"]["toolResponse"] = {**old, **new}
            if "task" in old or "task" in new:
                merged["claudeCode"]["toolResponse"]["task"] = {**obj(old.get("task")), **obj(new.get("task"))}
    return merged


def execution_evidence(name, args, meta, output, locations=()):
    args, meta, raw = obj(args), obj(meta), obj(output)
    response = obj(obj(meta.get("claudeCode")).get("toolResponse"))
    task = obj(response.get("task"))
    declared = obj(meta.get("sessionboxer/execution"))
    terminal = obj(meta.get("terminal_exit"))
    sources = {}
    candidates = [("sessionboxer_execution", declared), ("terminal_exit", terminal)]
    if name.lower() in COMMAND_TOOLS:
        candidates += [("structured_output", obj(raw.get("structuredContent"))), ("raw_output", raw), ("claude_task", task), ("claude_response", response)]

    def pick(field, aliases, valid):
        for source, value in candidates:
            for key in aliases:
                if valid(value.get(key)):
                    sources[field] = source
                    return value[key]
        return None

    code = pick("exitCode", ("exitCode", "exit_code"), valid_code)
    signal = pick("terminationSignal", ("terminationSignal", "signal"), lambda v: (text(v) and re.fullmatch(r"SIG[A-Z0-9]+", v)) or (type(v) is int and 0 < v < 128))
    timed_out = pick("timedOut", ("timedOut", "timed_out"), lambda v: type(v) is bool)
    interrupted = pick("interrupted", ("interrupted",), lambda v: type(v) is bool)
    transport = pick("transportOutcome", ("transportOutcome",), lambda v: v in ("succeeded", "failed")) or "unknown"
    wait_limit = response.get("timedOutAfterMs")
    wait_timed_out = True if type(wait_limit) in (int, float) and wait_limit > 0 else None
    if wait_timed_out:
        sources["waitTimedOut"] = "claude_response"
    expected = obj(meta.get("sessionboxer/diagnostic")).get("expectedExitCodes")
    expected = list(dict.fromkeys(expected)) if isinstance(expected, list) and 0 < len(expected) <= 32 and all(valid_code(v) for v in expected) else None
    cwd = args.get("workdir") or args.get("cwd") or meta.get("cognition.ai/cwd")

    def normalized(path, relative=True):
        value = path.replace("\\", "/")
        if relative and not value.startswith("/") and not re.match(r"^[a-z]:/", value, re.I) and text(cwd):
            value = f"{cwd}/{value}"
        value = posixpath.normpath(value)
        return value.lower() if re.match(r"^[a-z]:/", value, re.I) else value

    processes = set()

    def process(kind, value):
        if (text(value) and len(value) <= 2048) or (type(value) is int and 0 <= value <= 2**53 - 1):
            processes.add(f"{kind}:{digest(str(value))}")

    process("terminal", terminal.get("terminal_id"))
    process("shell", args.get("shell_id"))
    process("shell", meta.get("cognition.ai/backgroundShellId"))
    process("task", args.get("task_id"))
    process("task", response.get("backgroundTaskId"))
    process("task", task.get("task_id"))
    if name.lower() in COMMAND_TOOLS:
        for _, value in candidates:
            process("pid", value.get("pid", value.get("processId")))
            process("shell", value.get("shell_id"))
            process("terminal", value.get("terminalId"))
    if name.lower().endswith("terminal_read"):
        process("terminal", args.get("id"))
    targets = {digest(normalized(path)) for path in [args.get("file_path"), args.get("path"), *[obj(v).get("path") for v in locations]] if text(path)}
    if text(args.get("url")):
        targets.add(digest(args["url"]))
    running = text(response.get("backgroundTaskId")) or meta.get("cognition.ai/background") is True or task.get("status") == "running"
    outcome = "timed_out" if timed_out is True else "signalled" if signal is not None else "interrupted" if interrupted is True else ("succeeded" if code == 0 else "failed") if code is not None else "running" if running else "unknown"
    return {
        "exitCode": code, "terminationSignal": signal, "timedOut": timed_out, "interrupted": interrupted,
        "waitTimedOut": wait_timed_out, "processOutcome": outcome, "transportOutcome": transport,
        "expectedExitCodes": expected, "diagnosticSource": "declared" if expected else None, "sources": sources,
        "context": {"commandHash": digest(args["command"].strip()) if text(args.get("command")) else None,
                    "cwdHash": digest(normalized(cwd, False)) if text(cwd) else None,
                    "taskHash": digest(declared["taskId"]) if text(declared.get("taskId")) else None,
                    "processRefs": sorted(processes), "targetHashes": sorted(targets)},
    }


def merge_recorded_execution(legacy, recorded, name):
    parsed = execution_evidence(name, {}, {"sessionboxer/execution": recorded, "sessionboxer/diagnostic": {"expectedExitCodes": recorded.get("expectedExitCodes")}}, {})
    for key in ("exitCode", "terminationSignal", "timedOut", "interrupted", "transportOutcome"):
        if parsed[key] is not None and parsed[key] != "unknown":
            legacy[key] = parsed[key]
            source = obj(recorded.get("sources")).get(key)
            legacy["sources"][key] = source if source in ("terminal_exit", "raw_output", "structured_output", "claude_task", "claude_response", "sessionboxer_execution") else "recorded_telemetry"
    if type(recorded.get("waitTimedOut")) is bool:
        legacy["waitTimedOut"] = recorded["waitTimedOut"]
    if parsed["expectedExitCodes"]:
        legacy["expectedExitCodes"] = parsed["expectedExitCodes"]
        legacy["diagnosticSource"] = "declared"
    context = obj(recorded.get("context"))
    for key in ("commandHash", "cwdHash", "taskHash"):
        if text(context.get(key)) and re.fullmatch(r"[a-f0-9]{64}", context[key]):
            legacy["context"][key] = context[key]
    for key, pattern in (("processRefs", r"(?:terminal|shell|task|pid):[a-f0-9]{64}"), ("targetHashes", r"[a-f0-9]{64}")):
        values = context.get(key)
        if isinstance(values, list) and len(values) <= 100 and all(text(v) and re.fullmatch(pattern, v) for v in values):
            legacy["context"][key] = sorted(set(legacy["context"][key]) | set(values))
    legacy["processOutcome"] = "timed_out" if legacy["timedOut"] is True else "signalled" if legacy["terminationSignal"] is not None else "interrupted" if legacy["interrupted"] is True else ("succeeded" if legacy["exitCode"] == 0 else "failed") if legacy["exitCode"] is not None else "running" if recorded.get("processOutcome") == "running" or legacy["processOutcome"] == "running" else "unknown"
    return legacy


def action_hash(name, args):
    name, args = name.lower().split("__")[-1], obj(args)
    if name == "key":
        value = args.get("text", args.get("key"))
        return digest([name, value]) if text(value) else None
    if name == "scroll":
        direction = args.get("scroll_direction", args.get("direction"))
        if direction in ("up", "down", "left", "right"):
            return digest([name, direction, args.get("scroll_amount", args.get("amount", 3)), args.get("coordinate")])
    if name == "zoom":
        region = args.get("region")
        if region is None and all(type(args.get(k)) in (int, float) for k in ("x", "y", "width", "height")):
            region = [args["x"], args["y"], args["x"] + args["width"], args["y"] + args["height"]]
        if isinstance(region, list) and len(region) == 4 and all(type(v) in (int, float) for v in region):
            return digest([name, region])
    return None


def assessment(call, evidence):
    execution = call["execution"]
    expected = execution["expectedExitCodes"]
    outcome = execution["processOutcome"]
    if execution["transportOutcome"] == "failed":
        return "unexpected_failure" if expected else "unreviewed_failure"
    if expected and outcome in ("unknown", "running"):
        return "diagnostic_outcome_unknown"
    if outcome == "failed" and expected and execution["exitCode"] in expected:
        return "expected_diagnostic_failure"
    if outcome == "succeeded" and expected and 0 not in expected:
        return "unexpected_success"
    if evidence:
        return "unexpected_failure" if expected else "unreviewed_failure"
    return "command_succeeded" if outcome == "succeeded" else "unknown"


def recovery_match(failed, candidate):
    a, b = failed["execution"], candidate["execution"]
    ac, bc = a["context"], b["context"]
    if failed["turn_kind"] == "unknown" or candidate["turn_kind"] == "unknown":
        return None
    same_process = bool(set(ac["processRefs"]) & set(bc["processRefs"]))
    polling = candidate["tool"].lower() in {"get_output", "taskoutput", "terminal_read", "mcp__sessionboxer__terminal_read"}
    for key in ("taskHash", "cwdHash"):
        if ac[key] != bc[key] and (ac[key] and bc[key] or not (same_process and polling)):
            return None
    if candidate["status"] != "completed" or b["processOutcome"] in {*PROCESS_FAILURES, "running"} or b["transportOutcome"] == "failed":
        return None
    same_tool = failed["tool"].lower() == candidate["tool"].lower()
    command = failed["tool"].lower() in COMMAND_TOOLS
    same_command = bool(ac["commandHash"]) and ac["commandHash"] == bc["commandHash"]
    same_target = bool(set(ac["targetHashes"]) & set(bc["targetHashes"]))
    same_action = bool(failed["action_hash"]) and failed["action_hash"] == candidate["action_hash"]
    exact = failed["input_hash"] is not None and failed["input_hash"] == candidate["input_hash"]
    category = failed["error_code"]
    reasons = []
    if command:
        if same_command and candidate["tool"].lower() in COMMAND_TOOLS:
            reasons.append("same_command")
        elif same_process and polling and b["processOutcome"] == "succeeded":
            reasons.append("same_process_completion")
    elif same_tool:
        if same_target and category in {"edit_match", "not_found", "permission_denied", "invalid_arguments", "network", "timeout", "unclassified", "tool_error"}:
            reasons.append("same_affected_target")
        elif same_action and category == "invalid_arguments":
            reasons.append("same_action_corrected_schema")
        elif exact and failed["input_hash"] != digest({}):
            reasons.append("same_arguments")
    if not reasons:
        return None
    if ac["taskHash"] and ac["taskHash"] == bc["taskHash"]:
        reasons.append("same_explicit_task")
    if same_process:
        reasons.append("same_process_id")
    if same_target:
        reasons.append("target_overlap")
    confidence = "high" if b["processOutcome"] == "succeeded" else "medium"
    if command and (b["processOutcome"] == "unknown" or not ac["cwdHash"] or not bc["cwdHash"]):
        confidence = "low"
    return {"reasons": reasons, "error_category": category, "confidence": confidence,
            "success_evidence": "structured_exit" if b["processOutcome"] == "succeeded" else "provider_completed_only"}
