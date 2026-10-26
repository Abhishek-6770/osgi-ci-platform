# osgi-ci-platform

Centralized, reusable GitHub Actions for the Northwind OMS OSGi build. This repository is intended to be called from the product repository's `.github/workflows/ci.yaml`.

## Repository layout

```text
.github/
├── workflows/
│   ├── reusable-osgi-build.yml  # workflow_call: change detection, graphs, PDE build, artifacts/JFrog
│   ├── reusable-security.yml    # workflow_call: Gitleaks, Dependency Review, optional Trivy
│   ├── promote-osgi-build.yml   # manual JFrog build promotion
│   └── validate-platform.yml   # central JavaScript syntax validation
└── actions/
    ├── plan-osgi-build/         # OSGi metadata scanner, change planner, graph generation
    ├── build-osgi-pde/          # Eclipse PDE headless Ant build (not Maven/Tycho)
    ├── setup-eclipse-pde/       # Java + Eclipse SDK/PDE setup
    ├── validate-osgi-metadata/  # MANIFEST.MF and feature.xml checks
    ├── test-osgi-planner/       # planner tests against the caller's Northwind repo
    ├── publish-osgi-report/     # GitHub summary and artifact upload
    └── publish-osgi-jfrog/      # optional Artifactory build-info publishing
```

## How the product repository calls this platform

Copy `product-repo-example/.github/workflows/ci.yaml` from the setup package to the Northwind product repository at `.github/workflows/ci.yaml`.

The caller uses these workflows from this repository:

- `Abhishek-6770/osgi-ci-platform/.github/workflows/reusable-osgi-build.yml@main`
- `Abhishek-6770/osgi-ci-platform/.github/workflows/reusable-security.yml@main`

The reusable workflow refers to composite actions using fully qualified references such as `Abhishek-6770/osgi-ci-platform/.github/actions/plan-osgi-build@main`. It intentionally does not use relative `./.github/actions/...` references, since those paths would resolve from the caller's workspace.

## Setup in the Northwind product repository

Add the workflow to `.github/workflows/ci.yaml`. No reusable actions or planner code need to be copied into the product repository.

For optional JFrog publish, configure these in the product repository:

- Variable `JF_URL`: JFrog Platform URL.
- Variable `JF_GENERIC_REPO`: target Artifactory generic repository key.
- Secret `JF_ACCESS_TOKEN`: least-privilege token that can upload packages and publish build-info.

For Gitleaks, add `GITLEAKS_LICENSE` only if your repository/use case requires a license. The security workflow can still run without it where permitted by Gitleaks.

The manual `Promote OSGi Build in JFrog` workflow lives in this central repository. For that workflow, configure `JF_URL` and `JF_ACCESS_TOKEN` in the central repository, and protect its `release` environment if approvals are required.

## Important versioning note

This initial caller uses `@main` so it works as soon as these files are committed to `main`. For production, create an immutable release tag such as `v1` and change the caller's reusable workflow references—and the internal composite action references—to `@v1` or preferably to a reviewed commit SHA.

## Build engine

The product build uses Eclipse PDE headless Ant tooling. It does not invoke Maven or Tycho. Node.js is used only for OSGi change detection, dependency ordering, reporting, and graph generation. A real PDE build needs to be validated against the caller repository's actual target platform and `build.properties` configuration.
