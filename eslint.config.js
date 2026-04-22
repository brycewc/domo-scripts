const perfectionist = require('eslint-plugin-perfectionist');

module.exports = [
	{
		files: ['commands/bulk-transfer-ownership.js'],
		plugins: { perfectionist },
		rules: {
			'perfectionist/sort-modules': [
				'error',
				{
					type: 'natural',
					order: 'asc',
					// `_main` is pinned to the top via the `entry` custom group;
					// every other module-level function falls into `unknown` and
					// is sorted alphabetically.
					groups: ['entry', 'unknown'],
					customGroups: [
						{ groupName: 'entry', elementNamePattern: '^_main$' }
					]
				}
			]
		}
	}
];
