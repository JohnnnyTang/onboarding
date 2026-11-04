import type { ComponentsFile, Gesture, SeatId, TableRenderer, TableSnapshot } from "@bgp/schema";
import { useEffect, useRef, useState } from "react";
import styles from "./match.module.css";

export interface TableViewProps {
  components: ComponentsFile;
  assetUrl(ref: string): string;
  seat: SeatId | null;
  snapshot: TableSnapshot | null;
  selection: readonly string[];
  onGesture(gesture: Gesture): void;
  onSelectionChange(ids: string[]): void;
}

/** Starts downloading the renderer early; repeated calls share one download. */
export function preloadTable(): Promise<typeof import("@bgp/table-2d")> {
  return import("@bgp/table-2d");
}

/**
 * Hosts the 2D table renderer. PixiJS is loaded on demand, so pages without a table do not
 * download it. The renderer draws only the snapshot it is given.
 */
export function TableView(props: TableViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<TableRenderer<HTMLElement> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
  const { components, assetUrl, seat, snapshot, selection } = props;

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let cancelled = false;
    let instance: TableRenderer<HTMLElement> | null = null;
    const unsubscribe: (() => void)[] = [];
    void preloadTable()
      .then(async ({ PixiTableRenderer }) => {
        if (cancelled) return;
        instance = new PixiTableRenderer();
        await instance.mount(container, { components, assetUrl, seat });
        if (cancelled) return;
        unsubscribe.push(
          instance.onGesture((gesture) => latest.current.onGesture(gesture)),
          instance.onSelectionChange((ids) => latest.current.onSelectionChange(ids)),
        );
        renderer.current = instance;
        const current = latest.current;
        if (current.snapshot) instance.setSnapshot(current.snapshot);
        instance.setSelection([...current.selection]);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      for (const stop of unsubscribe) stop();
      renderer.current = null;
      instance?.destroy();
    };
  }, [components, assetUrl, seat]);

  useEffect(() => {
    if (snapshot) renderer.current?.setSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    renderer.current?.setSelection([...selection]);
  }, [selection]);

  return (
    <div ref={host} className={styles.table} data-testid="table">
      {failed ? (
        <p className={styles.banner} role="alert">
          The table could not be drawn in this browser.
        </p>
      ) : null}
    </div>
  );
}
