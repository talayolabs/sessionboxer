// Subset of noVNC's RFB API (docs/API.md) used by the Desktop pane; the package ships no types.
declare module "@novnc/novnc" {
  export interface RFBOptions {
    shared?: boolean;
    wsProtocols?: string[];
    credentials?: { username?: string; password?: string; target?: string };
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    /** Sends text to the server clipboard (no-op while view-only). */
    clipboardPasteFrom(text: string): void;
  }

  /** Payload of the `clipboard` event (text the server put in its clipboard). */
  export interface ClipboardEventDetail {
    text: string;
  }
}
