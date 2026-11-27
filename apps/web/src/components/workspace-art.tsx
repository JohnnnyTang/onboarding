import room from "./room.webp";
import shelf from "./shelf.webp";
import workshop from "./workshop.webp";

const pictures = { room, shelf, workshop };
export type WorkspaceKind = keyof typeof pictures;

export function WorkspaceArt({
  kind,
  className,
}: {
  kind: WorkspaceKind;
  className: string | undefined;
}) {
  return <img src={pictures[kind]} alt="" className={className} width={104} height={104} />;
}
