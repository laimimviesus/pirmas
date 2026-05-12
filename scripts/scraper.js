name: Mercell Scraper

on:
  workflow_dispatch:
    inputs:
      retranslate_stale:
        description: 'Backfill mode — re-translate stale TITLE/SCOPE only'
        type: boolean
        default: false
      test_mode:
        description: 'Test mode (tik ~9 tenderiai jei true)'
        required: false
        default: 'false'
        type: choice
        options:
          - 'false'
          - 'true'
      country_filter:
        description: 'Filter by country (e.g. "Spain" or "Spain,Portugal"). Tuščias = visi.'
        required: false
        default: ''
        type: string
  schedule:
    - cron: '0 0 * * *'

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 600
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm install puppeteer pdf-parse googleapis mammoth xlsx adm-zip

      - name: Install Chromium dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
            libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
            libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64

      - name: Run scraper
        env:
          MERCELL_USERNAME: ${{ secrets.MERCELL_USERNAME }}
          MERCELL_PASSWORD: ${{ secrets.MERCELL_PASSWORD }}
          GOOGLE_SERVICE_ACCOUNT_KEY: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_KEY }}
          GOOGLE_SHEET_ID: ${{ secrets.GOOGLE_SHEET_ID }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          PORTAL_CREDS_JSON: ${{ secrets.PORTAL_CREDS_JSON }}
          # Optional inputs forwarded from workflow_dispatch
          RETRANSLATE_STALE: ${{ inputs.retranslate_stale && '1' || '' }}
          TEST_MODE: ${{ inputs.test_mode || 'false' }}
          # NEW — country filter for targeted PLACSP debugging
          COUNTRY_FILTER: ${{ inputs.country_filter || '' }}
        run: node scripts/scraper.js 2>&1 | tee scraper-output.log

      - name: Save scraper log as artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: scraper-log-${{ github.run_number }}
          path: scraper-output.log
          retention-days: 7
