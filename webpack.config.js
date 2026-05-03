const path = require('path');

module.exports = {
    target: 'node',                // VS Code desktop extension host is Node.js
    entry: './src/extension.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
    },
    externals: {
        vscode: 'commonjs vscode',
        // serialport uses native bindings — load from node_modules at runtime
        serialport: 'commonjs serialport',
    },
    resolve: {
        extensions: ['.ts', '.js'],
        mainFields: ['main', 'module'],
    },
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: [{
                loader: 'ts-loader',
                options: { compilerOptions: { module: 'commonjs' } },
            }],
        }],
    },
    mode: 'production',
};
