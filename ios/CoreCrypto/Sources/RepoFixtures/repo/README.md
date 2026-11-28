# Staged repository files for phone test runs

`ios/tools/stage-device-fixtures.sh` copies the files the package's tests read
(forms, vendor scripts and pins, goldens, `tools/schema.json`) into this folder,
with the repository's layout, so they ship inside the test bundle. A phone
cannot read the Mac's disk.

Everything here except this README is a build input, ignored by git. The
simulator and host runs read the live repository files instead (see
`Sources/RepoFixtures/RepoFixtures.swift`). Do not edit the copies: change the
files in the repository and stage again.
