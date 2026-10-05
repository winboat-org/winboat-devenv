process.stdout.write("locked\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
