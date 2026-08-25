module.exports = [{
  ignores: ['.vscode-test/**', 'node_modules/**']
}, {
  files: ['**/*.js'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'commonjs'
  },
  linterOptions: {
    reportUnusedDisableDirectives: 'error'
  },
  rules: {
    'constructor-super': 'error',
    'for-direction': 'error',
    'getter-return': 'error',
    'no-async-promise-executor': 'error',
    'no-constant-binary-expression': 'error',
    'no-dupe-args': 'error',
    'no-dupe-class-members': 'error',
    'no-dupe-else-if': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-func-assign': 'error',
    'no-import-assign': 'error',
    'no-loss-of-precision': 'error',
    'no-new-native-nonconstructor': 'error',
    'no-obj-calls': 'error',
    'no-self-assign': 'error',
    'no-setter-return': 'error',
    'no-unreachable': 'error',
    'no-unreachable-loop': 'error',
    'no-unsafe-negation': 'error',
    'no-useless-backreference': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error'
  }
}];
