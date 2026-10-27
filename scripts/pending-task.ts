const [task, command] = process.argv.slice(2);
console.error(
  `${command ?? "This command"} is not implemented yet; it belongs to ${task ?? "a later task"}.`,
);
process.exitCode = 1;
