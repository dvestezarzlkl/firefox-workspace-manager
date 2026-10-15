/**
 * Firefox WebExtension runtime.
 *
 * The project models the domain objects it uses through JSDoc typedefs in
 * src/types/domain.js. The API surface itself remains dynamic here so we do
 * not need a generated third-party declaration bundle in the extension repo.
 */
declare const browser: any;
