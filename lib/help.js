function showHelp(argv, helpText) {
	if (argv.help || argv.h) {
		console.log(helpText);
		process.exit(0);
	}
}

module.exports = { showHelp };
