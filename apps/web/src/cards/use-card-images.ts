import { loadCardImages } from "@bgp/card-generator";
import { useEffect, useState } from "react";
import type { ProjectAsset } from "../projects/project-store";

const EMPTY: ReadonlyMap<string, ImageBitmap> = new Map();

/**
 * Decoded project images for card previews, by path. Generated faces (assets/cards/) are
 * left out: templates draw imported art, and a project may hold hundreds of faces.
 */
export function useCardImages(assets: readonly ProjectAsset[]): ReadonlyMap<string, ImageBitmap> {
  const [images, setImages] = useState(EMPTY);
  useEffect(() => {
    let cancelled = false;
    let loaded: Map<string, ImageBitmap> | null = null;
    void loadCardImages(
      assets
        .filter((asset) => !asset.path.startsWith("assets/cards/"))
        .map((asset) => [asset.path, asset.blob]),
    ).then((decoded) => {
      if (cancelled) {
        for (const image of decoded.values()) image.close();
        return;
      }
      loaded = decoded;
      setImages(decoded);
    });
    return () => {
      cancelled = true;
      for (const image of loaded?.values() ?? []) image.close();
    };
  }, [assets]);
  return images;
}
