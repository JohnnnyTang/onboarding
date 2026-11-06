import { Route, Routes } from "react-router";
import { CALLBACK_PATH } from "../auth/auth";
import { AuthCallbackPage } from "../pages/auth-callback";
import { GamePage, GamesPage } from "../pages/games";
import { HomePage } from "../pages/home";
import { HotSeatPage } from "../pages/hot-seat";
import { JoinPage } from "../pages/join";
import { LobbyPage } from "../pages/lobby";
import { MatchPage } from "../pages/match";
import { MatchesPage } from "../pages/matches";
import { NotFoundPage, ReplayPage } from "../pages/placeholders";
import { ProjectPage } from "../pages/project";
import { ProjectsPage } from "../pages/projects";
import { VersionPage } from "../pages/version";
import { Layout } from "./layout";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectPage />} />
        <Route path="projects/:projectId/play" element={<HotSeatPage />} />
        <Route path="projects/:projectId/:section" element={<ProjectPage />} />
        <Route path="games" element={<GamesPage />} />
        <Route path="games/:gameId" element={<GamePage />} />
        <Route path="games/:gameId/versions/:versionId" element={<VersionPage />} />
        <Route path="matches" element={<MatchesPage />} />
        <Route path="matches/:matchId" element={<MatchPage />} />
        <Route path="matches/:matchId/lobby" element={<LobbyPage />} />
        <Route path="matches/:matchId/replay" element={<ReplayPage />} />
        <Route path="join/:token" element={<JoinPage />} />
        <Route path={CALLBACK_PATH.slice(1)} element={<AuthCallbackPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
