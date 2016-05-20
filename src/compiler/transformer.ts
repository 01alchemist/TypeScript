/// <reference path="visitor.ts" />
/// <reference path="transformers/ts.ts" />
/// <reference path="transformers/jsx.ts" />
/// <reference path="transformers/es7.ts" />
/// <reference path="transformers/es6.ts" />
/// <reference path="transformers/module/module.ts" />
/// <reference path="transformers/module/system.ts" />
/// <reference path="transformers/module/es6.ts" />

/* @internal */
namespace ts {
    const moduleTransformerMap: Map<Transformer> = {
        [ModuleKind.ES6]: transformES6Module,
        [ModuleKind.System]: transformSystemModule,
        [ModuleKind.AMD]: transformModule,
        [ModuleKind.CommonJS]: transformModule,
        [ModuleKind.UMD]: transformModule,
        [ModuleKind.None]: transformModule,
    };

    const enum SyntaxKindFeatureFlags {
        Substitution = 1 << 0,
        EmitNotifications = 1 << 1,
    }

    export function getTransformers(compilerOptions: CompilerOptions) {
        const jsx = compilerOptions.jsx;
        const languageVersion = getEmitScriptTarget(compilerOptions);
        const moduleKind = getEmitModuleKind(compilerOptions);
        const transformers: Transformer[] = [];

        transformers.push(transformTypeScript);
        transformers.push(moduleTransformerMap[moduleKind]);

        if (jsx === JsxEmit.React) {
            transformers.push(transformJsx);
        }

        transformers.push(transformES7);

        if (languageVersion < ScriptTarget.ES6) {
            transformers.push(transformES6);
        }

        return transformers;
    }

    /**
     * Transforms an array of SourceFiles by passing them through each transformer.
     *
     * @param resolver The emit resolver provided by the checker.
     * @param host The emit host.
     * @param sourceFiles An array of source files
     * @param transforms An array of Transformers.
     */
    export function transformFiles(resolver: EmitResolver, host: EmitHost, sourceFiles: SourceFile[], transformers: Transformer[]) {
        const nodeEmitOptions: NodeEmitOptions[] = [];
        const lexicalEnvironmentVariableDeclarationsStack: VariableDeclaration[][] = [];
        const lexicalEnvironmentFunctionDeclarationsStack: FunctionDeclaration[][] = [];
        const enabledSyntaxKindFeatures = new Array<SyntaxKindFeatureFlags>(SyntaxKind.Count);
        let lexicalEnvironmentStackOffset = 0;
        let hoistedVariableDeclarations: VariableDeclaration[];
        let hoistedFunctionDeclarations: FunctionDeclaration[];
        let currentSourceFile: SourceFile;
        let lexicalEnvironmentDisabled: boolean;

        // The transformation context is provided to each transformer as part of transformer
        // initialization.
        const context: TransformationContext = {
            getCompilerOptions: () => host.getCompilerOptions(),
            getEmitResolver: () => resolver,
            getEmitHost: () => host,
            getNodeEmitFlags,
            setNodeEmitFlags,
            getSourceMapRange,
            setSourceMapRange,
            getTokenSourceMapRange,
            setTokenSourceMapRange,
            getCommentRange,
            setCommentRange,
            hoistVariableDeclaration,
            hoistFunctionDeclaration,
            startLexicalEnvironment,
            endLexicalEnvironment,
            onSubstituteNode,
            enableSubstitution,
            isSubstitutionEnabled,
            onEmitNode,
            enableEmitNotification,
            isEmitNotificationEnabled
        };

        // Chain together and initialize each transformer.
        const transformation = chain(...transformers)(context);

        // Transform each source file.
        return map(sourceFiles, transformSourceFile);

        /**
         * Transforms a source file.
         *
         * @param sourceFile The source file to transform.
         */
        function transformSourceFile(sourceFile: SourceFile) {
            if (isDeclarationFile(sourceFile)) {
                return sourceFile;
            }

            currentSourceFile = sourceFile;
            return transformation(sourceFile);
        }

        /**
         * Enables expression substitutions in the pretty printer for the provided SyntaxKind.
         */
        function enableSubstitution(kind: SyntaxKind) {
            enabledSyntaxKindFeatures[kind] |= SyntaxKindFeatureFlags.Substitution;
        }

        /**
         * Determines whether expression substitutions are enabled for the provided node.
         */
        function isSubstitutionEnabled(node: Node) {
            return (enabledSyntaxKindFeatures[node.kind] & SyntaxKindFeatureFlags.Substitution) !== 0;
        }

        /**
         * Default hook for node substitutions.
         *
         * @param node The node to substitute.
         * @param isExpression A value indicating whether the node is to be used in an expression
         *                     position.
         */
        function onSubstituteNode(node: Node, isExpression: boolean) {
            return node;
        }

        /**
         * Enables before/after emit notifications in the pretty printer for the provided SyntaxKind.
         */
        function enableEmitNotification(kind: SyntaxKind) {
            enabledSyntaxKindFeatures[kind] |= SyntaxKindFeatureFlags.EmitNotifications;
        }

        /**
         * Determines whether before/after emit notifications should be raised in the pretty
         * printer when it emits a node.
         */
        function isEmitNotificationEnabled(node: Node) {
            return (enabledSyntaxKindFeatures[node.kind] & SyntaxKindFeatureFlags.EmitNotifications) !== 0
                || (getNodeEmitFlags(node) & NodeEmitFlags.AdviseOnEmitNode) !== 0;
        }

        /**
         * Default hook for node emit.
         *
         * @param node The node to emit.
         * @param emit A callback used to emit the node in the printer.
         */
        function onEmitNode(node: Node, emit: (node: Node) => void) {
            // Ensure that lexical environment modifications are disabled during the print phase.
            if (!lexicalEnvironmentDisabled) {
                const savedLexicalEnvironmentDisabled = lexicalEnvironmentDisabled;
                lexicalEnvironmentDisabled = true;
                emit(node);
                lexicalEnvironmentDisabled = savedLexicalEnvironmentDisabled;
                return;
            }

            emit(node);
        }

        function getEmitOptions(node: Node, create?: boolean) {
            let options = isSourceTreeNode(node)
                ? nodeEmitOptions[getNodeId(node)]
                : node.emitOptions;
            if (!options && create) {
                options = { };
                if (isSourceTreeNode(node)) {
                    nodeEmitOptions[getNodeId(node)] = options;
                }
                else {
                    node.emitOptions = options;
                }
            }
            return options;
        }

        /**
         * Gets flags that control emit behavior of a node.
         */
        function getNodeEmitFlags(node: Node) {
            while (node) {
                const options = getEmitOptions(node, /*create*/ false);
                if (options && options.flags !== undefined) {
                    if (options.flags & NodeEmitFlags.Merge) {
                        options.flags = (options.flags | getNodeEmitFlags(node.original)) & ~NodeEmitFlags.Merge;
                    }

                    return options.flags;
                }

                node = node.original;
            }

            return undefined;
        }

        /**
         * Sets flags that control emit behavior of a node.
         */
        function setNodeEmitFlags<T extends Node>(node: T, flags: NodeEmitFlags) {
            const options = getEmitOptions(node, /*create*/ true);
            if (flags & NodeEmitFlags.Merge) {
                flags = options.flags | (flags & ~NodeEmitFlags.Merge);
            }

            options.flags = flags;
            return node;
        }

        /**
         * Gets a custom text range to use when emitting source maps.
         */
        function getSourceMapRange(node: Node) {
            let current = node;
            while (current) {
                const options = getEmitOptions(current);
                if (options && options.sourceMapRange !== undefined) {
                    return options.sourceMapRange;
                }

                current = current.original;
            }

            return node;
        }

        /**
         * Sets a custom text range to use when emitting source maps.
         */
        function setSourceMapRange<T extends Node>(node: T, range: TextRange) {
            getEmitOptions(node, /*create*/ true).sourceMapRange = range;
            return node;
        }

        function getTokenSourceMapRanges(node: Node) {
            let current = node;
            while (current) {
                const options = getEmitOptions(current);
                if (options && options.tokenSourceMapRange) {
                    return options.tokenSourceMapRange;
                }

                current = current.original;
            }

            return undefined;
        }

        /**
         * Gets the TextRange to use for source maps for a token of a node.
         */
        function getTokenSourceMapRange(node: Node, token: SyntaxKind) {
            const ranges = getTokenSourceMapRanges(node);
            if (ranges) {
                return ranges[token];
            }

            return undefined;
        }

        /**
         * Sets the TextRange to use for source maps for a token of a node.
         */
        function setTokenSourceMapRange<T extends Node>(node: T, token: SyntaxKind, range: TextRange) {
            const options = getEmitOptions(node, /*create*/ true);
            if (!options.tokenSourceMapRange) {
                const existingRanges = getTokenSourceMapRanges(node);
                const ranges = existingRanges ? clone(existingRanges) : { };
                options.tokenSourceMapRange = ranges;
            }

            options.tokenSourceMapRange[token] = range;
            return node;
        }

        /**
         * Gets a custom text range to use when emitting comments.
         */
        function getCommentRange(node: Node) {
            let current = node;
            while (current) {
                const options = getEmitOptions(current, /*create*/ false);
                if (options && options.commentRange !== undefined) {
                    return options.commentRange;
                }

                current = current.original;
            }

            return node;
        }

        /**
         * Sets a custom text range to use when emitting comments.
         */
        function setCommentRange<T extends Node>(node: T, range: TextRange) {
            getEmitOptions(node, /*create*/ true).commentRange = range;
            return node;
        }

        /**
         * Records a hoisted variable declaration for the provided name within a lexical environment.
         */
        function hoistVariableDeclaration(name: Identifier): void {
            Debug.assert(!lexicalEnvironmentDisabled, "Cannot modify the lexical environment during the print phase.");
            const decl = createVariableDeclaration(name);
            if (!hoistedVariableDeclarations) {
                hoistedVariableDeclarations = [decl];
            }
            else {
                hoistedVariableDeclarations.push(decl);
            }
        }

        /**
         * Records a hoisted function declaration within a lexical environment.
         */
        function hoistFunctionDeclaration(func: FunctionDeclaration): void {
            Debug.assert(!lexicalEnvironmentDisabled, "Cannot modify the lexical environment during the print phase.");
            if (!hoistedFunctionDeclarations) {
                hoistedFunctionDeclarations = [func];
            }
            else {
                hoistedFunctionDeclarations.push(func);
            }
        }

        /**
         * Starts a new lexical environment. Any existing hoisted variable or function declarations
         * are pushed onto a stack, and the related storage variables are reset.
         */
        function startLexicalEnvironment(): void {
            Debug.assert(!lexicalEnvironmentDisabled, "Cannot start a lexical environment during the print phase.");

            // Save the current lexical environment. Rather than resizing the array we adjust the
            // stack size variable. This allows us to reuse existing array slots we've
            // already allocated between transformations to avoid allocation and GC overhead during
            // transformation.
            lexicalEnvironmentVariableDeclarationsStack[lexicalEnvironmentStackOffset] = hoistedVariableDeclarations;
            lexicalEnvironmentFunctionDeclarationsStack[lexicalEnvironmentStackOffset] = hoistedFunctionDeclarations;
            lexicalEnvironmentStackOffset++;
            hoistedVariableDeclarations = undefined;
            hoistedFunctionDeclarations = undefined;
        }

        /**
         * Ends a lexical environment. The previous set of hoisted declarations are restored and
         * any hoisted declarations added in this environment are returned.
         */
        function endLexicalEnvironment(): Statement[] {
            Debug.assert(!lexicalEnvironmentDisabled, "Cannot end a lexical environment during the print phase.");

            let statements: Statement[];
            if (hoistedVariableDeclarations || hoistedFunctionDeclarations) {
                if (hoistedFunctionDeclarations) {
                    statements = [...hoistedFunctionDeclarations];
                }

                if (hoistedVariableDeclarations) {
                    const statement = createVariableStatement(
                        /*modifiers*/ undefined,
                        createVariableDeclarationList(hoistedVariableDeclarations)
                    );

                    if (!statements) {
                        statements = [statement];
                    }
                    else {
                        statements.push(statement);
                    }
                }
            }

            // Restore the previous lexical environment.
            lexicalEnvironmentStackOffset--;
            hoistedVariableDeclarations = lexicalEnvironmentVariableDeclarationsStack[lexicalEnvironmentStackOffset];
            hoistedFunctionDeclarations = lexicalEnvironmentFunctionDeclarationsStack[lexicalEnvironmentStackOffset];
            return statements;
        }
    }

    /**
     * High-order function, creates a function that executes a function composition.
     * For example, `chain(a, b)` is the equivalent of `x => ((a', b') => y => b'(a'(y)))(a(x), b(x))`
     *
     * @param args The functions to chain.
     */
    function chain<T, U>(...args: ((t: T) => (u: U) => U)[]): (t: T) => (u: U) => U;
    function chain<T, U>(a: (t: T) => (u: U) => U, b: (t: T) => (u: U) => U, c: (t: T) => (u: U) => U, d: (t: T) => (u: U) => U, e: (t: T) => (u: U) => U): (t: T) => (u: U) => U {
        if (e) {
            const args = arrayOf<(t: T) => (u: U) => U>(arguments);
            return t => compose(...map(args, f => f(t)));
        }
        else if (d) {
            return t => compose(a(t), b(t), c(t), d(t));
        }
        else if (c) {
            return t => compose(a(t), b(t), c(t));
        }
        else if (b) {
            return t => compose(a(t), b(t));
        }
        else if (a) {
            return t => compose(a(t));
        }
        else {
            return t => u => u;
        }
    }

    /**
     * High-order function, composes functions. Note that functions are composed inside-out;
     * for example, `compose(a, b)` is the equivalent of `x => b(a(x))`.
     *
     * @param args The functions to compose.
     */
    function compose<T>(...args: ((t: T) => T)[]): (t: T) => T;
    function compose<T>(a: (t: T) => T, b: (t: T) => T, c: (t: T) => T, d: (t: T) => T, e: (t: T) => T): (t: T) => T {
        if (e) {
            const args = arrayOf(arguments);
            return t => reduceLeft<(t: T) => T, T>(args, (u, f) => f(u), t);
        }
        else if (d) {
            return t => d(c(b(a(t))));
        }
        else if (c) {
            return t => c(b(a(t)));
        }
        else if (b) {
            return t => b(a(t));
        }
        else if (a) {
            return t => a(t);
        }
        else {
            return t => t;
        }
    }

    /**
     * Makes an array from an ArrayLike.
     */
    function arrayOf<T>(arrayLike: ArrayLike<T>) {
        const length = arrayLike.length;
        const array: T[] = new Array<T>(length);
        for (let i = 0; i < length; i++) {
            array[i] = arrayLike[i];
        }
        return array;
    }
}