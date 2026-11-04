import { useCallback, useEffect, useState } from "react";

/**
 * A small always-on-top window, for keeping the code up over slides.
 *
 * This is the Document Picture-in-Picture API: Chrome and Edge 116 and later,
 * nothing else yet. An ordinary popup will not do, because a fullscreen slide
 * show covers it; a picture-in-picture window stays above everything, fullscreen
 * apps included, and the lecturer can drag it wherever it is out of the way.
 *
 * The window is empty when it opens. What goes in it is rendered by React from
 * this tab through a portal (see PipPortal), so it is the same component tree,
 * the same state and the same realtime subscription — nothing is copied
 * across or kept in step by hand. Only the styles have to be carried over,
 * along with the classes on <html> that switch dark mode and the accessibility
 * settings, which are watched so a change made here shows there too.
 *
 * Opening it needs a click: the browser refuses a request that does not come
 * straight from one. It closes when this tab closes, since it belongs to it.
 *
 * It cannot be see-through. The browser draws it as a normal opaque window and
 * gives the page no say over that.
 */

type DocumentPictureInPicture = {
  requestWindow: (options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }) => Promise<Window>;
  window: Window | null;
};

const api = (): DocumentPictureInPicture | null =>
  (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture ?? null;

/** Every stylesheet on this page, recreated in the other window's head. */
const copyStyles = (target: Document) => {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      target.head.appendChild(style);
    } catch {
      // A cross-origin sheet (a web font, say) will not hand over its rules.
      // Linking it again loads the same file.
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
};

/** Dark mode, high contrast, text size: all live on <html> here. */
const copyRoot = (target: Document) => {
  target.documentElement.className = document.documentElement.className;
  const style = document.documentElement.getAttribute("style");
  if (style) target.documentElement.setAttribute("style", style);
  else target.documentElement.removeAttribute("style");
};

export const usePictureInPicture = () => {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const supported = api() !== null;

  const open = useCallback(
    async ({ width, height, title }: { width: number; height: number; title: string }) => {
      const pip = api();
      if (!pip) return null;
      // One at a time; asking again just brings the existing one back.
      if (pip.window) {
        pip.window.focus();
        return pip.window;
      }

      const w = await pip.requestWindow({
        width,
        height,
        // The browser's own "back to tab" button would close the window
        // without telling the page anything it could not already see, but it
        // also tries to focus this tab, which pulls it over the slides.
        disallowReturnToOpener: true,
      });
      copyStyles(w.document);
      copyRoot(w.document);
      w.document.title = title;
      w.document.body.className = "bg-background text-foreground";

      w.addEventListener("pagehide", () => setPipWindow(null), { once: true });
      setPipWindow(w);
      return w;
    },
    [],
  );

  const close = useCallback(() => {
    api()?.window?.close();
    setPipWindow(null);
  }, []);

  // Theme or accessibility changed on this page: follow it.
  useEffect(() => {
    if (!pipWindow) return;
    const observer = new MutationObserver(() => copyRoot(pipWindow.document));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, [pipWindow]);

  // Leaving the page takes the window with it rather than stranding an empty one.
  useEffect(() => () => api()?.window?.close(), []);

  return { supported, pipWindow, open, close };
};
