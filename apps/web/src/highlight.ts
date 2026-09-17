import { common, createLowlight } from "lowlight";

/** Grammars for fenced code (`common` = the ~40 usual languages), shared by the chat and the prompt editor. */
export const GRAMMARS = common;

export const lowlight = createLowlight(GRAMMARS);
