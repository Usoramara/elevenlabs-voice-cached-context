// Type declarations for optional tool dependencies
// These modules are dynamically imported and fail gracefully at runtime if not installed

declare module 'pdf-parse' {
  export class PDFParse {
    constructor(buf: Buffer);
    load(): Promise<unknown>;
    getText(): Promise<string>;
    getInfo(): Promise<{ numpages?: number; numPages?: number; pages?: number }>;
  }
}

declare module '@mozilla/readability' {
  export class Readability {
    constructor(document: unknown, options?: { charThreshold?: number });
    parse(): { textContent?: string; title?: string } | null;
  }
}

declare module 'linkedom' {
  export function parseHTML(html: string): { document: unknown };
}
