# Notes for agents working on RealView

## Versioning

RealView does not use standard semantic versioning. The version in `src/manifest.json` is
`major.middle.third`, and the rules are:

- **Bug fix:** move the third number up by one. `1.5.3` becomes `1.5.4`.
- **New feature:** move the middle number up by one and leave the third number where it is.
  `1.5.4` becomes `1.6.4`, not `1.6.0` and not `1.5.5`.
- **The third number is never reset.** It carries on counting across every release, so it always
  tells you how many fixes have shipped in total.

A change made in response to a bug report is a bug fix, however large the diff, unless Eric says
it is a feature. If you are unsure whether a change is a fix or a feature, ask rather than guess.

## Releasing

1. Bump `"version"` in `src/manifest.json` following the rules above.
2. Add an entry at the top of `src/changelog.json` with that version, today's date and one line
   per change. Write for the person using the extension: what they will see differently, not
   which function changed.
3. Run `node test/interceptor.test.js` and `node test/changelog.test.js`. The changelog test
   fails if the top entry does not match the manifest version.
4. Always pack the extension into a zip for the new version, without waiting to be asked. Eric
   tests each release by loading the zip himself. The zip goes in `~/Downloads`, is named
   `RealView-extension-<version>.zip`, and holds one top-level folder called `RealView-extension`
   with the contents of `src/`, which is the layout the README's setup steps expect. Remove any
   older RealView zip you created earlier in the same session so only the current one is left.

   ```sh
   VERSION=$(node -p "require('./src/manifest.json').version")
   STAGE=$(mktemp -d)
   mkdir "$STAGE/RealView-extension"
   cp -R src/. "$STAGE/RealView-extension/"
   (cd "$STAGE" && zip -qr ~/Downloads/RealView-extension-$VERSION.zip RealView-extension -x '*.DS_Store')
   rm -rf "$STAGE"
   unzip -l ~/Downloads/RealView-extension-$VERSION.zip
   ```

   Check that the listing shows `manifest.json` at the new version before reporting the release
   as done.
