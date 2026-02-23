// PDF text extraction tool

export interface PdfReadOutput {
  text: string;
  pages: number;
  truncated: boolean;
}

const MAX_PDF_SIZE = 20_000_000; // 20MB
const MAX_TEXT_LENGTH = 50_000;

export async function readPdf(params: {
  url: string;
  max_pages?: number;
}): Promise<PdfReadOutput> {
  const res = await fetch(params.url, {
    signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'Wybe/1.0' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch PDF (${res.status}): ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('pdf') && !params.url.toLowerCase().endsWith('.pdf')) {
    throw new Error(`URL does not appear to be a PDF (content-type: ${contentType})`);
  }

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_PDF_SIZE) {
    throw new Error(`PDF too large (${(arrayBuffer.byteLength / 1_000_000).toFixed(1)}MB). Maximum: 20MB.`);
  }

  try {
    const pdfModule = await import('pdf-parse');
    const PDFParse = (pdfModule as Record<string, unknown>).PDFParse as new (buf: Buffer) => {
      load(): Promise<unknown>;
      getText(): Promise<string>;
      getInfo(): Promise<{ numpages?: number; numPages?: number; pages?: number }>;
    };

    const parser = new PDFParse(Buffer.from(arrayBuffer));
    await parser.load();

    const text = await parser.getText();
    const info = await parser.getInfo();
    const numPages = info.numpages ?? info.numPages ?? info.pages ?? 0;

    const truncated = text.length > MAX_TEXT_LENGTH;
    const resultText = truncated ? text.slice(0, MAX_TEXT_LENGTH) : text;

    return {
      text: resultText.trim(),
      pages: numPages,
      truncated,
    };
  } catch {
    const text = extractRawPdfText(Buffer.from(arrayBuffer));
    return {
      text: text || 'Failed to extract text from PDF. The file may be image-based or encrypted.',
      pages: 0,
      truncated: false,
    };
  }
}

function extractRawPdfText(buffer: Buffer): string {
  const str = buffer.toString('latin1');
  const textChunks: string[] = [];

  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(str)) !== null) {
    const block = match[1];
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjRegex.exec(block)) !== null) {
      textChunks.push(tjMatch[1]);
    }
  }

  return textChunks.join(' ').replace(/\\n/g, '\n').replace(/\s+/g, ' ').trim();
}
