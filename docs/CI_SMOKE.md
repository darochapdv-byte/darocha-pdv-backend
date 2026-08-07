# CI sugerido (GitHub Actions)

Crie `.github/workflows/ci.yml` com um token que tenha scope `workflow`, ou cole no painel Actions:

```yaml
name: Backend CI
on:
  push:
    branches: [master, main]
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci --omit=dev || npm install --omit=dev
      - run: |
          node --check src/index.js
          node --check src/auth.js
          node --check src/entities.js
      - run: curl -fsS --max-time 30 https://darocha-pdv-backend.onrender.com/health
        continue-on-error: true
```
