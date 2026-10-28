export class GameError extends Error {
  readonly code = "GAME_ERROR";

  constructor() {
    super("Game execution failed");
  }
}
