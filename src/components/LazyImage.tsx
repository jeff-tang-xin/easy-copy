import { useState, useEffect, useRef, type ImgHTMLAttributes } from "react";

interface LazyImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  /** Image source — will only be fetched when the element enters the viewport. */
  src: string;
  /** Placeholder text shown while loading. Default: "加载中…" */
  placeholder?: string;
  /** Root margin for IntersectionObserver (how far in advance to load). Default: "200px" */
  rootMargin?: string;
  /** Optional callback when image finishes loading. */
  onLoad?: () => void;
}

/**
 * LazyImage — IntersectionObserver-based lazy-loaded image.
 *
 * Images outside the viewport are not fetched at all, which matters for
 * the clipboard list when the user has 200+ image items. Without lazy
 * loading every `get_image_data` IPC call fires on first render, even
 * for items the user will never scroll to — that's N round-trips of
 * base64 PNG data for zero benefit.
 *
 * Uses `IntersectionObserver` (available in all modern WebView2 versions).
 * Falls back to "load immediately" if the API is missing (shouldn't happen
 * in Tauri, but belt-and-braces).
 */
export function LazyImage({
  src,
  placeholder = "加载中…",
  rootMargin = "200px",
  alt = "",
  className = "",
  onLoad,
  ...rest
}: LazyImageProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || isVisible) return;

    if (typeof IntersectionObserver === "undefined") {
      // No IntersectionObserver → load immediately.
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin, threshold: 0.01 },
    );

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [isVisible, rootMargin]);

  const handleLoad = () => {
    setLoaded(true);
    onLoad?.();
  };

  return (
    <div ref={ref} className={`lazy-image-wrapper ${className}`}>
      {isVisible ? (
        <img
          src={src}
          alt={alt}
          onLoad={handleLoad}
          className={`lazy-image ${loaded ? "lazy-image-loaded" : "lazy-image-loading"}`}
          {...rest}
        />
      ) : (
        <span className="img-placeholder lazy-placeholder">{placeholder}</span>
      )}
    </div>
  );
}
