import { ClaimInviteBodySchema } from "@bgp/schema";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiError } from "../api/client";
import { errorMessage } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import { PageHeader, ui } from "../components/ui";

function claimError(error: unknown): string {
  if (error instanceof ApiError && error.code === "NOT_FOUND") {
    return "This invite link is not valid. Ask the host for a new one.";
  }
  return errorMessage(error);
}

/** `/join/:token`: claim a seat as a guest, or as the signed-in designer. */
export function JoinPage() {
  const { token = "" } = useParams();
  const { api, seats } = useServices();
  const user = useAuthUser();
  const navigate = useNavigate();
  const inputId = useId();
  const [displayName, setDisplayName] = useState(user?.name.slice(0, 80) ?? "");
  const [invalid, setInvalid] = useState(false);
  const claim = useMutation({
    mutationFn: (name: string) => api.claimInvite(token, { displayName: name }),
    onSuccess: (claimed, name) => {
      seats.set({
        matchId: claimed.matchId,
        seat: claimed.seat,
        displayName: name,
        guestToken: claimed.guestToken ?? null,
      });
      navigate(`/matches/${encodeURIComponent(claimed.matchId)}/lobby`, { replace: true });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = ClaimInviteBodySchema.safeParse({ displayName: displayName.trim() });
    setInvalid(!body.success);
    if (body.success) claim.mutate(body.data.displayName);
  }

  return (
    <>
      <PageHeader title="Join a match">
        {user
          ? `You will join as ${user.name}'s account.`
          : "No account needed: pick the name other players will see."}
      </PageHeader>
      <form onSubmit={submit} noValidate>
        <div className={ui.field}>
          <label htmlFor={inputId}>Display name</label>
          <input
            id={inputId}
            name="displayName"
            autoComplete="nickname"
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={invalid}
          />
        </div>
        {invalid ? (
          <p className={ui.notice} role="alert">
            Enter a display name of 1 to 80 characters.
          </p>
        ) : null}
        {claim.isError ? (
          <p className={ui.notice} role="alert">
            {claimError(claim.error)}
          </p>
        ) : null}
        <button type="submit" className={ui.button} disabled={claim.isPending}>
          {claim.isPending ? "Joining…" : "Join"}
        </button>
      </form>
    </>
  );
}
