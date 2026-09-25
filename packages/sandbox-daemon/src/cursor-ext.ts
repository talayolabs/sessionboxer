import type { ClientApp } from "@agentclientprotocol/sdk";
import { z } from "zod";

/**
 * Cursor's ACP extension methods (ADR-0054). Two of them block the turn until the client answers:
 * `cursor/ask_question` (the AskQuestion tool) and `cursor/create_plan` (Plan mode handing over a
 * plan). Nobody sits at the Sandbox's ACP client, so the question is skipped with a reason the
 * model reads (state it in the reply, the user answers in the chat) and the plan is accepted
 * (Cursor then writes its own plan file). The others are progress reports Cursor sends as requests
 * whose answer it ignores ("non-blocking extension notifications"); they are acknowledged so its
 * log stays free of "method not found" and the todo list reaches the daemon log.
 */
const AskQuestionParams = z.object({
  toolCallId: z.string().optional(),
  title: z.string().optional(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        options: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
        allowMultiple: z.boolean().optional(),
      }),
    )
    .default([]),
});

type AskQuestionResponse = {
  outcome:
    | { outcome: "answered"; answers: { questionId: string; selectedOptionIds: string[] }[] }
    | { outcome: "skipped"; reason?: string }
    | { outcome: "cancelled" };
};

const Todo = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
});

const CreatePlanParams = z.object({
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  overview: z.string().optional(),
  plan: z.string().default(""),
  todos: z.array(Todo).default([]),
  isProject: z.boolean().optional(),
  phases: z.array(z.object({ name: z.string(), todos: z.array(Todo).default([]) })).optional(),
});

type CreatePlanResponse = {
  outcome: { outcome: "accepted"; planUri?: string } | { outcome: "rejected"; reason?: string } | { outcome: "cancelled" };
};

const UpdateTodosParams = z.object({
  toolCallId: z.string(),
  todos: z.array(Todo),
  merge: z.boolean(),
});

const TaskParams = z.object({
  toolCallId: z.string(),
  description: z.string(),
  prompt: z.string(),
  subagentType: z.string().optional(),
  model: z.string().optional(),
  agentId: z.string().optional(),
  durationMs: z.number().optional(),
});

const GenerateImageParams = z.object({
  toolCallId: z.string(),
  description: z.string(),
  filePath: z.string().optional(),
  referenceImagePaths: z.array(z.string()).optional(),
});

export const ASK_QUESTION_SKIPPED_REASON =
  "Nobody is at this prompt: Sessionboxer runs the agent unattended. Decide yourself when you can; " +
  "when you really need the user's choice, ask the question in your reply and end the turn — the user answers in the chat.";

export function registerCursorExtensions(app: ClientApp, log: (msg: string) => void): ClientApp {
  return app
    .onRequest("cursor/ask_question", AskQuestionParams, (ctx): AskQuestionResponse => {
      const n = ctx.params.questions.length;
      log(`cursor asked ${n} question${n === 1 ? "" : "s"} (${ctx.params.title ?? "untitled"}); skipped, the model asks in the chat instead`);
      return { outcome: { outcome: "skipped", reason: ASK_QUESTION_SKIPPED_REASON } };
    })
    .onRequest("cursor/create_plan", CreatePlanParams, (ctx): CreatePlanResponse => {
      const todos = ctx.params.todos.length + (ctx.params.phases ?? []).reduce((n, p) => n + p.todos.length, 0);
      log(`cursor handed over a plan (${ctx.params.name ?? "unnamed"}, ${todos} todos); accepted`);
      return { outcome: { outcome: "accepted" } };
    })
    .onRequest("cursor/update_todos", UpdateTodosParams, (ctx): Record<string, never> => {
      const done = ctx.params.todos.filter((t) => t.status === "completed").length;
      log(`cursor todos: ${done}/${ctx.params.todos.length} done${ctx.params.merge ? " (merged)" : ""}`);
      return {};
    })
    .onRequest("cursor/task", TaskParams, (ctx): Record<string, never> => {
      const took = ctx.params.durationMs === undefined ? "started" : `took ${Math.round(ctx.params.durationMs / 1000)} s`;
      log(`cursor subagent ${ctx.params.subagentType ?? "task"}: ${ctx.params.description} (${took})`);
      return {};
    })
    .onRequest("cursor/generate_image", GenerateImageParams, (ctx): Record<string, never> => {
      log(`cursor generated an image: ${ctx.params.filePath ?? ctx.params.description}`);
      return {};
    });
}
