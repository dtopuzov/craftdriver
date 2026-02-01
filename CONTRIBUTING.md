# Contributing to Craftdriver

Thank you for your interest in contributing! This document provides guidelines and instructions.

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/dtopuzov/craftdriver.git
   cd craftdriver
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Install ChromeDriver** (required for tests)
   ```bash
   npm install -g chromedriver
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Run tests**
   ```bash
   # Start the test server in one terminal
   npm run serve

   # Run tests in another terminal
   npm test
   ```

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/) for automatic versioning and changelog generation.

### Format
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types
| Type | Description | Version Bump |
|------|-------------|--------------|
| `feat` | New feature | Minor (0.x.0) |
| `fix` | Bug fix | Patch (0.0.x) |
| `docs` | Documentation only | No release |
| `style` | Code style (formatting) | No release |
| `refactor` | Code refactoring | No release |
| `perf` | Performance improvement | Patch |
| `test` | Adding/updating tests | No release |
| `chore` | Maintenance tasks | No release |

### Breaking Changes
Add `BREAKING CHANGE:` in the footer or `!` after the type:
```
feat!: remove deprecated type() method

BREAKING CHANGE: browser.type() has been removed, use browser.fill() instead
```

### Examples
```bash
# Feature (minor version bump)
git commit -m "feat(browser): add getByRole() locator helper"

# Bug fix (patch version bump)
git commit -m "fix(expect): correct timeout handling in toHaveText()"

# Documentation (no release)
git commit -m "docs: update README with new examples"

# Breaking change (major version bump)
git commit -m "feat!: rename type() to fill() for consistency"
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with proper commit messages
3. Ensure all tests pass: `npm test`
4. Ensure code is formatted: `npm run format`
5. Ensure no lint errors: `npm run lint`
6. Open a Pull Request with a clear description

## Code Style

- TypeScript strict mode
- ESLint + Prettier for formatting
- Prefer async/await over raw promises
- Write tests for new features

## Running Specific Tests

```bash
# Run a specific test file
npm test -- tests/login.test.ts

# Run tests matching a pattern
npm test -- --grep "fill"
```

## Questions?

Open an issue or start a discussion on GitHub.
