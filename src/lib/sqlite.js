/**
 * Naively determine whether a table, column, or view name could lead to SQL
 * injection.
 *
 * Sometimes, you want to write a query like this:
 *
 *     sql`SELECT * FROM ${myTable}`
 *
 * Unfortunately, SQLite doesn't allow this sort of thing. That means we have to
 * use string interpolation (a raw query), which could be dangerous due to SQL
 * injection. This helps keep that safe.
 *
 * This check returns false negatives. For example, SQLite supports empty table
 * names which this function would mark unsafe. This simple check is enough for
 * our purposes.
 *
 * @param {string} name
 * @returns {boolean}
 */
export const isNameSafe = (name) =>
  name.length > 0 &&
  name.length < 1000 &&
  !name.toLowerCase().startsWith('sqlite') &&
  /^[a-zA-Z_][a-zA-Z0-9_]*$/g.test(name)
