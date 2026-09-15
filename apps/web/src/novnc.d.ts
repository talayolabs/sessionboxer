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
  }
}
