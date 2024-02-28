import type {
  JSCodeshift,
  Transform,
  Collection,
  MemberExpression,
} from 'jscodeshift'

/**
 * Convert all `brittle` imports to `tape` imports.
 */
const rewriteImports = (j: JSCodeshift, root: Collection<any>) => {
  root
    .find(j.ImportDeclaration, {
      type: 'ImportDeclaration',
      source: { value: 'brittle' },
    })
    .forEach((brittleImport) => {
      brittleImport.value.specifiers = [
        j.importDefaultSpecifier(j.identifier('test')),
      ]
      brittleImport.value.source = j.stringLiteral('tape')
    })
}

/**
 * Rewrite member expressions like `obj.prop`.
 *
 * Given `rewriteMemberExpressions(j, root, "foo", "bar")`, produces a diff like:
 *
 * ```diff
 * -one.foo
 * -two.foo(1, 2, 3)
 * +one.bar
 * +two.bar(1, 2, 3)
 * ```
 */
const rewriteMemberExpressions = (
  j: JSCodeshift,
  root: Collection<any>,
  oldPropertyName: string,
  newPropertyName: string
) => {
  root
    .find(j.MemberExpression, { property: { name: oldPropertyName } })
    .forEach((memberExpression) => {
      memberExpression.value.property = j.identifier(newPropertyName)
    })
}

/**
 * Rewrite `t.exception.all` to `t.exception`.
 */
const rewriteExceptionAll = (j: JSCodeshift, root: Collection<any>) => {
  root
    .find(j.MemberExpression, {
      object: {
        type: 'MemberExpression',
        property: { name: 'exception' },
      },
      property: { name: 'all' },
    })
    .forEach((memberExpression) => {
      memberExpression.value.object = (
        memberExpression.value.object as MemberExpression
      ).object
      memberExpression.value.property = j.identifier('exception')
    })
}

/**
 * Rewrite `t.exception` and `t.exception.all`.
 *
 * If passed a synchronous function, do a simple rewrite to `t.throws`.
 *
 * If passed anything else, convert to `rejects(t, ...args)` and make sure `rejects` is imported.
 */
const rewriteExceptions = (j: JSCodeshift, root: Collection<any>) => {
  rewriteExceptionAll(j, root)
}

const transform: Transform = (fileInfo, api) => {
  const { j } = api
  const root = j(fileInfo.source)

  rewriteImports(j, root)

  rewriteMemberExpressions(j, root, 'alike', 'deepEqual')
  rewriteMemberExpressions(j, root, 'unlike', 'notDeepEqual')
  rewriteMemberExpressions(j, root, 'absent', 'notOk')
  rewriteMemberExpressions(j, root, 'execution', 'doesNotThrow')

  rewriteExceptions(j, root)

  return root.toSource()
}

export default transform
