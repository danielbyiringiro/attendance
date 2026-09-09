import { buildGrid, type PositionedText } from "./layout";
import { findHeaderRow, preambleOf } from "./columns";
import type { ExtractedTable } from "./types";

/**
 * Reading a class list out of a PDF.
 *
 * Kept as thin as it can be: get the positioned text out of pdfjs, hand it to
 * layout.ts, and stop. All the guessing lives next door where it can be tested
 * against invented coordinates instead of a real document.
 *
 * pdfjs is loaded on demand. It is about a megabyte, this bundle already warns
 * about its size, and most TAs will never upload a PDF at all — so it should
 * not be in the main chunk.
 *
 * Nothing is saved. The file is read into an ArrayBuffer, the document is
 * destroyed before this returns, and nothing is written to disk or network.
 */

let pdfjs: typeof import("pdfjs-dist") | null = null;

const loadPdfjs = async () => {
  if (pdfjs) return pdfjs;

  const lib = await import("pdfjs-dist");

  // The worker has to be told where it lives. Vite's ?url gives a hashed asset
  // path that survives the build, which a bare string path does not.
  const workerUrl = (
    await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ).default;

  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  pdfjs = lib;
  return lib;
};

/** A pdfjs text run, as much of it as is used here. */
interface PdfTextItem {
  str: string;
  height?: number;
  width?: number;
  transform: number[];
}

/**
 * Extract every text run, with its position, from every page.
 *
 * PDF coordinates start at the bottom-left and go up; everything downstream
 * assumes top-left and down, so y is flipped once, here, rather than being a
 * source of confusion in the layout code.
 *
 * Pages are stacked into one grid rather than kept separate: a class list
 * running over three pages is one table, and the repeated column titles are
 * dealt with when the mapping is applied.
 */
export const readPdfFile = async (file: File): Promise<ExtractedTable> => {
  const lib = await loadPdfjs();

  const doc = await lib.getDocument({
    data: await file.arrayBuffer(),
    // No network fetches for fonts or maps: this must work offline, and a
    // roster upload has no business reaching out to anything.
    isEvalSupported: false,
  }).promise;

  try {
    const rows: string[][] = [];

    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const height = page.getViewport({ scale: 1 }).height;

      const items: PositionedText[] = [];

      for (const raw of content.items as unknown as PdfTextItem[]) {
        if (typeof raw.str !== "string" || !raw.str.trim()) continue;

        // transform is [a, b, c, d, e, f]; e and f are the position, and d is
        // the vertical scale, which is the font size in practice.
        const [, , , d, e, f] = raw.transform;
        const h = raw.height && raw.height > 0 ? raw.height : Math.abs(d) || 10;

        items.push({
          text: raw.str,
          x: e,
          y: height - f - h, // bottom-left origin to top-left
          width: raw.width ?? 0,
          height: h,
        });
      }

      rows.push(...buildGrid(items));
      page.cleanup();
    }

    const headerRow = findHeaderRow(rows);

    return {
      kind: "pdf",
      rows,
      preamble: preambleOf(rows, headerRow),
      pageCount: doc.numPages,
    };
  } finally {
    // Frees the worker's copy of the document. Without this the file's text
    // stays in memory for as long as the tab is open.
    await doc.destroy();
  }
};
