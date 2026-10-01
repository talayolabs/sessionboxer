import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from audit_tools import audit, safe_cell, write_report


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "input.sqlite"
        self.db = sqlite3.connect(self.path)
        self.db.executescript("CREATE TABLE sessions(id TEXT, provider TEXT); CREATE TABLE events(session_id TEXT, branch_id TEXT, seq INTEGER, ts TEXT, body TEXT);")
        self.db.executemany("INSERT INTO sessions VALUES (?,?)", [("s", "claude-code"), ("fork", "devin"), ("other", "devin")])
        self.event(0, {"type": "user_prompt", "text": "fixture turn"})

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def event(self, seq, body, session="s", branch="root", second=None):
        second = seq if second is None else second
        stamp = f"2026-09-01T00:{second // 60:02}:{second % 60:02}.000Z"
        self.db.execute("INSERT INTO events VALUES (?,?,?,?,?)", (session, branch, seq, stamp, json.dumps(body)))

    def call(self, seq, id, name="Read", args=None, status="completed", session="s", branch="root", output="OK", start_second=None):
        self.event(seq, {"type": "update", "update": {"sessionUpdate": "tool_call", "toolCallId": id, "name": name, "rawInput": args or {}, "status": "pending"}}, session, branch, start_second)
        self.event(seq + 1, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": id, "status": status, "rawOutput": output}}, session, branch)

    def run_audit(self):
        self.db.commit()
        before = self.path.read_bytes()
        result = audit(self.path)
        self.assertEqual(before, self.path.read_bytes())
        return result

    def test_streams_forks_and_id_collisions(self):
        self.call(1, "same", args={"file_path": "secret"})
        self.call(1, "same", args={"file_path": "secret"}, session="fork")
        self.event(4, {"type": "forked", "fromSessionId": "s"}, "fork")
        self.call(1, "same", args={"file_path": "secret"}, session="other")
        self.event(3, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "same", "status": "completed"}})
        result = self.run_audit()
        self.assertEqual(result["summary"]["calls"], 2)
        self.assertEqual(result["summary"]["copied_call_occurrences"], 1)
        self.assertEqual(sum(r["calls"] for r in result["leaderboard"]), 2)
        self.assertNotIn("secret", json.dumps(result))

    def test_partial_input_recovery_and_turn_boundary(self):
        self.event(1, {"type": "user_prompt", "text": "private request"})
        self.call(2, "bad", "Bash", {"command": "private command"}, "failed", output="Exit code: 1")
        self.call(5, "good", "Bash", {"command": "private command"})
        self.event(8, {"type": "turn_ended", "stopReason": "end_turn"})
        self.event(9, {"type": "user_prompt", "text": "next"})
        self.call(10, "again", "Bash", {"command": "private command"})
        result = self.run_audit()
        self.assertEqual(result["failures"][0]["recovery"], "evidence_matched_candidate")
        self.assertEqual([x["kind"] for x in result["sequences"]], ["unchanged_retry"])
        self.assertNotIn("private", json.dumps(result))

    def test_wait_screenshot_incomplete_and_unknown_model(self):
        self.call(1, "wait", "mcp__desktop__wait", {"duration": 2}, output=[{"type": "image", "data": "private"}])
        self.call(4, "shot", "mcp__desktop__screenshot")
        self.event(7, {"type": "update", "update": {"sessionUpdate": "tool_call", "toolCallId": "open", "name": "exec"}})
        result = self.run_audit()
        self.assertEqual(result["summary"]["incomplete"], 1)
        self.assertIn("wait_then_screenshot", [r["kind"] for r in result["sequences"]])
        self.assertTrue(all(row["model"] is None for row in result["calls"]))

    def test_structured_telemetry_and_completed_error(self):
        self.event(1, {"type": "user_prompt", "turnId": "t", "text": "hi"})
        self.event(2, {"type": "turn_context", "context": {"version": 1, "turnId": "t", "model": "model-v1", "configuredInstructionsHash": "hash"}})
        self.call(3, "a", "exec", output={"isError": True, "content": [{"type": "text", "text": "Permission denied"}]})
        self.event(5, {"type": "tool_execution", "execution": {"version": 1, "toolCallId": "a", "turnId": "t", "observedDurationMs": 40, "executionMs": 12, "errorCode": "permission_denied"}})
        result = self.run_audit()
        self.assertEqual(result["calls"][0]["execution_ms"], 12)
        self.assertEqual(result["calls"][0]["observed_ms"], 40)
        self.assertEqual(result["calls"][0]["model"], "model-v1")
        self.assertEqual(result["failures"][0]["evidence"], "result_is_error")

    def test_orphan_updates_and_bad_json(self):
        self.event(1, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "orphan", "status": "failed"}})
        self.db.execute("INSERT INTO events VALUES ('s','root',2,'bad','not json')")
        result = self.run_audit()
        self.assertEqual(result["summary"]["orphan_calls"], 1)
        self.assertEqual(result["summary"]["invalid_events"], 1)
        self.assertIsNone(result["calls"][0]["observed_ms"])

    def test_no_recovery_across_branches_or_concurrent_calls(self):
        self.call(1, "bad", "Read", {"file_path": "x"}, "failed")
        self.call(3, "other-branch", "Read", {"file_path": "x"}, branch="b")
        self.call(6, "concurrent", "Read", {"file_path": "x"}, start_second=1)
        result = self.run_audit()
        self.assertEqual(result["failures"][0]["recovery"], "not_observed")

    def test_partial_inputs_are_folded_and_long_blocking_polls_are_low_priority(self):
        for seq in (1, 5, 9):
            self.call(seq, str(seq), "get_output", {"shell_id": "private", "timeout": 280000})
        result = self.run_audit()
        self.assertEqual(result["sequences"][0]["kind"], "long_running_process_wait")
        self.assertLess(result["sequences"][0]["score"], 30)
        self.event(15, {"type": "update", "update": {"sessionUpdate": "tool_call", "toolCallId": "read", "name": "Read", "rawInput": {}}})
        self.event(16, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "read", "rawInput": {"file_path": "private"}}})
        self.event(17, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "read", "status": "failed"}})
        self.call(18, "retry", "Read", {"file_path": "private"})
        self.assertIn("unchanged_retry", [r["kind"] for r in self.run_audit()["sequences"]])

    def test_verification_attempts_are_not_final_outcomes(self):
        self.db.executescript("CREATE TABLE e2e_runs(id TEXT,session_id TEXT,turn_seq INTEGER,status TEXT); CREATE TABLE e2e_cases(run_id TEXT,idx INTEGER,cycle INTEGER,status TEXT);")
        self.event(1, {"type": "user_prompt", "text": "test"})
        self.call(2, "a")
        self.event(5, {"type": "turn_ended", "stopReason": "end_turn"})
        self.db.execute("INSERT INTO e2e_runs VALUES ('r','s',5,'passed')")
        self.db.executemany("INSERT INTO e2e_cases VALUES ('r',1,?,?)", [(1, "failed"), (2, "passed")])
        result = self.run_audit()
        self.assertEqual(result["verification"]["runs"][0]["failed_attempts"], 1)
        self.assertEqual(result["verification"]["runs"][0]["latest_case_statuses"], {"passed": 1})
        self.assertEqual(result["calls"][0]["verification_outcomes"], ["passed"])

    def test_mcp_measurements_join_only_by_execution_id(self):
        measurement = {"version": 1, "executionId": "execution", "server": "desktop", "toolName": "wait", "executionMs": 10, "toolSchemaHash": "hash", "errorCode": None}
        self.event(1, {"type": "mcp_execution", "execution": measurement})
        self.call(2, "a", "mcp__desktop__wait", output={"_meta": {"sessionboxer/telemetry": measurement}, "content": []})
        self.event(4, {"type": "mcp_execution", "execution": measurement})
        self.event(5, {"type": "mcp_execution", "execution": {**measurement, "executionId": "unlinked"}})
        result = self.run_audit()
        self.assertEqual(result["summary"]["mcp_measurements"], 2)
        self.assertEqual(result["summary"]["mcp_measurements_linked"], 1)
        self.assertEqual(result["summary"]["calls"], 1)
        self.assertEqual(result["calls"][0]["execution_ms"], 10)

    def test_report_exports_are_safe_and_refuse_overwriting(self):
        self.call(1, "a", args={"password": "private"}, output="private")
        report = self.run_audit()
        output = Path(self.tmp.name) / "report"
        write_report(report, output)
        self.assertNotIn("private", (output / "audit.json").read_text())
        self.assertTrue((output / "leaderboard.csv").is_file())
        self.assertEqual(safe_cell("=formula"), "'=formula")
        with self.assertRaises(FileExistsError):
            write_report(report, output)

    def test_structured_nonzero_exit_is_not_transport_failure(self):
        self.call(1, "exec", "exec", {"command": "pytest fixture"}, output="Exit code: 0")
        self.event(2, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "exec", "_meta": {"terminal_exit": {"terminal_id": "private-process", "exit_code": 1, "signal": None}}}})
        result = self.run_audit()
        self.assertEqual(result["calls"][0]["execution"]["exitCode"], 1)
        self.assertEqual(result["calls"][0]["execution"]["transportOutcome"], "unknown")
        self.assertEqual(result["failures"][0]["evidence"], "structured_process_failure")
        self.assertEqual(result["failures"][0]["assessment"], "unreviewed_failure")
        self.assertNotIn("private-process", json.dumps(result))

    def test_structured_success_overrides_exit_text_but_not_tool_failure(self):
        self.call(1, "ok", "exec", output={"exitCode": 0, "content": [{"type": "text", "text": "documentation: Exit code: 9"}]})
        self.call(4, "failed", "exec", status="failed", output={"exitCode": 0})
        result = self.run_audit()
        self.assertEqual(len(result["failures"]), 1)
        self.assertEqual(result["failures"][0]["tool_call_id"], "failed")
        self.assertEqual(result["calls"][0]["execution"]["processOutcome"], "succeeded")

    def test_background_wait_deadline_and_negative_exit_are_unknown_not_failed(self):
        self.call(1, "bg", "Bash")
        self.event(3, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "bg", "_meta": {"claudeCode": {"toolResponse": {"backgroundTaskId": "private-task", "timedOutAfterMs": 1000}}}}})
        self.call(4, "negative", "exec", output={"exit_code": -1})
        result = self.run_audit()
        self.assertEqual(result["calls"][0]["execution"]["processOutcome"], "running")
        self.assertIsNone(result["calls"][0]["execution"]["timedOut"])
        self.assertEqual(result["calls"][1]["execution"]["processOutcome"], "unknown")
        self.assertEqual(result["failures"], [])

    def test_expected_diagnostic_exit_requires_explicit_matching_review(self):
        self.call(1, "test", "exec", {"command": "pytest"}, output={"exitCode": 1})
        baseline = self.run_audit()
        reviews = {"version": 1, "snapshot_fingerprint": baseline["snapshot_fingerprint"], "calls": [{"session_id": "s", "start_seq": 1, "tool_call_id": "test", "expected_exit_codes": [1]}]}
        result = audit(self.path, reviews)
        self.assertEqual(result["failures"][0]["assessment"], "expected_diagnostic_failure")
        self.assertEqual(result["failures"][0]["recovery"], "not_required_expected_diagnostic")
        self.assertEqual(result["summary"]["expected_diagnostic_failures"], 1)
        reviews["snapshot_fingerprint"] = "wrong snapshot"
        with self.assertRaises(ValueError):
            audit(self.path, reviews)

    def test_unrelated_bash_success_is_not_recovery_and_same_command_is(self):
        self.event(1, {"type": "user_prompt", "text": "test"})
        self.call(2, "bad", "Bash", {"command": "npm test", "workdir": "/workspace/project"}, output={"exitCode": 1})
        self.call(5, "unrelated", "Bash", {"command": "git status", "workdir": "/workspace/project"}, output={"exitCode": 0})
        self.call(8, "retry", "Bash", {"command": "npm test", "workdir": "/workspace/project", "timeout": 5000}, output={"exitCode": 0})
        result = self.run_audit()
        failure = result["failures"][0]
        self.assertEqual(failure["candidate_reference"]["tool_call_id"], "retry")
        self.assertIn("same_command", failure["recovery_evidence"]["reasons"])
        self.assertEqual(failure["recovery_evidence"]["confidence"], "high")

    def test_same_shell_different_command_and_task_are_not_recovery(self):
        self.call(1, "bad", "exec", {"command": "npm test", "shell_id": "same"}, output={"exitCode": 1})
        self.call(4, "different", "exec", {"command": "git status", "shell_id": "same"}, output={"exitCode": 0})
        self.call(7, "different-directory", "exec", {"command": "npm test", "workdir": "/other"}, output={"exitCode": 1})
        self.call(10, "retry-other-directory", "exec", {"command": "npm test", "workdir": "/not-other"}, output={"exitCode": 0})
        result = self.run_audit()
        self.assertEqual(result["failures"][1]["recovery"], "not_observed")
        self.assertIsNone(result["failures"][0]["candidate_reference"])

    def test_poll_completion_matches_process_only_with_structured_success(self):
        self.call(1, "bad", "exec", {"command": "run build", "shell_id": "process"}, "failed", output="timeout")
        self.call(4, "other", "get_output", {"shell_id": "unrelated"}, output={"exitCode": 0})
        self.call(7, "poll", "get_output", {"shell_id": "process"}, output={"exitCode": 0})
        result = self.run_audit()
        self.assertEqual(result["failures"][0]["candidate_reference"]["tool_call_id"], "poll")
        self.assertIn("same_process_completion", result["failures"][0]["recovery_evidence"]["reasons"])

    def test_poll_of_reused_shell_does_not_recover_an_earlier_command(self):
        self.call(1, "bad", "exec", {"command": "npm test", "shell_id": "shared"}, "failed", output="timeout")
        self.call(4, "replacement", "exec", {"command": "git status", "shell_id": "shared"}, output={"exitCode": 0})
        self.call(7, "poll", "get_output", {"shell_id": "shared"}, output={"exitCode": 0})
        self.assertEqual(self.run_audit()["failures"][0]["recovery"], "not_observed")

    def test_reviewed_key_alias_and_edit_target_patterns(self):
        cases = [
            ("mcp__desktop__key", {"key": "Return"}, {"text": "Return"}, "validation error", True),
            ("mcp__desktop__key", {"key": "Return"}, {"text": "Escape"}, "validation error", False),
            ("edit", {"file_path": "/workspace/private", "old_string": "old"}, {"file_path": "/workspace/private", "old_string": "corrected"}, "old_string not found", True),
            ("mcp__desktop__zoom", {"x": 10, "y": 20, "width": 30, "height": 40}, {"region": [20, 30, 80, 90]}, "validation error", False),
        ]
        for i, (tool, before, after, error, related) in enumerate(cases):
            seq = 1 + i * 10
            self.event(seq, {"type": "user_prompt", "text": "synthetic reviewed pattern"})
            self.call(seq + 1, f"bad-{i}", tool, before, "failed", output=error)
            self.call(seq + 4, f"candidate-{i}", tool, after)
        result = self.run_audit()
        for failure, case in zip(result["failures"], cases):
            self.assertEqual(failure["recovery"] != "not_observed", case[-1])
        self.assertNotIn("private", json.dumps(result))

    def test_explicit_tasks_and_agents_are_hard_recovery_boundaries(self):
        for i, task in enumerate(("private-task-a", "private-task-b")):
            seq = 1 + i * 3
            self.call(seq, str(i), "exec", {"command": "npm test"}, output={"exitCode": 1 if i == 0 else 0})
            self.event(seq + 2, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": str(i), "_meta": {"sessionboxer/execution": {"taskId": task}}}})
        result = self.run_audit()
        self.assertEqual(result["failures"][0]["recovery"], "not_observed")
        self.assertNotIn("private-task", json.dumps(result))
        self.event(7, {"type": "user_prompt", "text": "another turn"})
        for seq, cid, agent in [(8, "agent-a", "a"), (11, "agent-b", "b")]:
            self.call(seq, cid, "exec", {"command": "npm test"}, output={"exitCode": 1 if agent == "a" else 0})
            self.event(seq + 2, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": cid, "_meta": {"cognition.ai/subagent_context": {"agentId": agent, "parentAgentId": "root"}}}})
        self.assertEqual(self.run_audit()["failures"][1]["recovery"], "not_observed")

    def test_no_recovery_after_a_closed_turn_without_a_new_prompt(self):
        self.call(1, "bad", "exec", {"command": "npm test"}, output={"exitCode": 1})
        self.event(3, {"type": "turn_ended", "stopReason": "end_turn"})
        self.call(4, "later", "exec", {"command": "npm test"}, output={"exitCode": 0})
        self.assertEqual(self.run_audit()["failures"][0]["recovery"], "not_observed")

    def test_expected_diagnostic_with_missing_exit_remains_unknown(self):
        self.call(1, "test", "Bash", {"command": "npm test"}, "failed", output="Exit code: 1")
        self.event(3, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "test", "_meta": {"sessionboxer/diagnostic": {"expectedExitCodes": [1]}}}})
        result = self.run_audit()
        self.assertEqual(result["calls"][0]["assessment"], "diagnostic_outcome_unknown")
        self.assertEqual(result["calls"][0]["execution"]["processOutcome"], "unknown")
        self.assertEqual(result["summary"]["expected_diagnostic_failures"], 0)

    def test_expected_exit_does_not_excuse_a_timeout(self):
        self.call(1, "timeout", "exec", output={"exitCode": 1, "timedOut": True})
        self.event(3, {"type": "update", "update": {"sessionUpdate": "tool_call_update", "toolCallId": "timeout", "_meta": {"sessionboxer/diagnostic": {"expectedExitCodes": [1]}}}})
        result = self.run_audit()
        self.assertEqual(result["calls"][0]["assessment"], "unexpected_failure")
        self.assertEqual(result["summary"]["expected_diagnostic_failures"], 0)

    def test_reviewed_pair_labels_validate_rather_than_override_matching(self):
        self.call(1, "bad", "exec", {"command": "npm test"}, output={"exitCode": 1})
        self.call(4, "different", "exec", {"command": "git status"}, output={"exitCode": 0})
        baseline = self.run_audit()
        pair = {"failure": {"session_id": "s", "start_seq": 1, "tool_call_id": "bad"}, "candidate": {"session_id": "s", "start_seq": 4, "tool_call_id": "different"}, "label": "not_same_operation"}
        reviews = {"version": 1, "snapshot_fingerprint": baseline["snapshot_fingerprint"], "recovery_pairs": [pair]}
        self.assertEqual(audit(self.path, reviews)["review_validation"]["counts"], {"correct_rejection": 1})
        pair["label"] = "related_retry"
        result = audit(self.path, reviews)
        self.assertEqual(result["review_validation"]["counts"], {"missed_related": 1})
        self.assertEqual(result["failures"][0]["recovery"], "not_observed")

    def test_report_is_deterministic(self):
        self.call(1, "a")
        self.assertEqual(self.run_audit(), self.run_audit())


if __name__ == "__main__":
    unittest.main()
