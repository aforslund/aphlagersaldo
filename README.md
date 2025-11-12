# Apotek Hjärtat Stock Level Checker

A web application to check stock levels across multiple systems: Google Feed, CommerceTools (Autocomplete API), Fluent, and NYCE.

## Features

- **Password Protection**: Secure access with configurable password via environment variable
- **Multiple Input Methods**:
  - CSV file upload for PSIDs
  - Manual entry (comma or newline separated PSIDs)
  - NYCE CSV upload (when API is unavailable)
- **Flexible Checking Modes**:
  - **Full Check**: Google Feed + CommerceTools + Fluent + NYCE
  - **Skip Google Feed**: For items already known to be unavailable (simplified spärr detection)
  - **Skip NYCE**: Check only CommerceTools and Fluent
  - **NYCE CSV Mode**: Upload NYCE data from CSV when API is unavailable
- **Multi-System Stock Checking**:
  - Google Feed (sellable status) - optional
  - CommerceTools via Autocomplete API (inventory quantity)
  - Fluent (onHand inventory)
  - NYCE (detailed warehouse stock data) - optional or CSV
- **Smart Analysis**:
  - Automatic classification of OK vs issues
  - Detailed insights based on stock levels across systems
  - NYCE-specific analysis for staging, inspection, and sync issues
  - Simplified spärr detection when Google Feed is skipped
- **Clean UI**:
  - OK items hidden in expandable section
  - Issues prominently displayed with actionable insights
  - Color-coded status indicators
  - Check options for flexible workflows

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:

```env
# Password protection
ACCESS_PASSWORD=your_secure_password_here

# Fluent API
FLUENT_ENDPOINT=https://HJARTATPROD.api.fluentretail.com/graphql
FLUENT_USERNAME=your_username
FLUENT_PASSWORD=your_password
FLUENT_CLIENT_ID=your_client_id
FLUENT_CLIENT_SECRET=your_client_secret
FLUENT_LOCATION_REF=EHL_hjartat

# NYCE API
NYCE_BASE_URL=https://nyce-app01.test.nyce.aph.icacorp.net
NYCE_USERNAME=extapiuser
NYCE_PASSWORD=your_nyce_password
NYCE_CLIENT=APH
NYCE_WAREHOUSE=NRKPG2

# Public URLs (no change needed)
NEXT_PUBLIC_GOOGLE_FEED_URL=https://www.apotekhjartat.se/api/feeds/products
NEXT_PUBLIC_AUTOCOMPLETE_URL=https://www.apotekhjartat.se/api/autocomplete
```

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment to Vercel

### Option 1: Vercel CLI

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Deploy:
```bash
vercel
```

3. Add environment variables in Vercel dashboard or via CLI:
```bash
vercel env add ACCESS_PASSWORD
vercel env add FLUENT_USERNAME
# ... etc for all env variables
```

### Option 2: Vercel Dashboard

1. Push your code to GitHub
2. Import the repository in [Vercel Dashboard](https://vercel.com/dashboard)
3. Add all environment variables from `.env.example` in the Environment Variables section
4. Deploy

## Usage

1. **Login**: Enter the password you configured in `ACCESS_PASSWORD`

2. **Input PSIDs**: Either:
   - Upload a CSV file with PSIDs
   - Type/paste PSIDs (comma or newline separated)

3. **Configure Check Options** (optional):
   - ✅ **Skip Google Feed check**: Use this when you already know items are unavailable on the website. This enables simplified spärr detection - if both CommerceTools and Fluent have stock, it's very likely a business logic block.
   - ✅ **Skip NYCE check**: Only check CommerceTools and Fluent inventory
   - 📄 **Upload NYCE CSV**: If NYCE API is unavailable from your location, upload a CSV file with columns: `SKU`, `Balance`, `InOrder` (see `nycestockreport-example.csv`)

4. **Check Stock**: Click "Check Stock Levels"

5. **Review Results**:
   - OK items are collapsed by default (click to expand)
   - Items with issues are displayed prominently with analysis and recommendations

### Check Modes

**Standard Mode** (no options checked):
- Checks all 4 systems: Google Feed → CommerceTools → Fluent → NYCE
- Full analysis using the logic matrix
- Best for comprehensive stock investigation

**Skip Google Feed Mode** (checkbox checked):
- Use when items are already known to be unavailable on website
- Focuses on spärr detection: if CT + Fluent have stock = likely spärr
- Faster workflow for known issues

**NYCE CSV Mode** (CSV uploaded):
- Use when NYCE API is not accessible from your location
- Upload CSV export from NYCE system
- Same full analysis as API mode

**CT + Fluent Only** (Skip NYCE checked):
- Quick check of just CommerceTools and Fluent sync
- No warehouse-level analysis

## Stock Analysis Logic

The application analyzes stock across 4 systems following the flow:
**NYCE (Master EHL lagersaldo) → Fluent (Master digitalt säljbart saldo) → CommerceTools (borde spegla Fluent med viss fördröjning) → Google Feed (CommerceTools saldo + affärslogik som spärr)**

### OK Status
- Google Feed shows "sellable" (in_stock)
- All systems (CommerceTools, Fluent, NYCE) have stock > 0

### Issue Classification

When Google Feed shows "NOT SELLABLE", the app follows this logic matrix:

1. **TROLIGTVIS EN SPÄRR** (Probably a block)
   - CommerceTools: >0, Fluent: >0, NYCE: >0
   - All systems have stock but Google Feed blocks selling
   - Indicates business logic restriction (affärslogik spärr)
   - Action: Check business rules in Google Feed logic

2. **TROLIGTVIS SYNKPROBLEM** (Probably sync problem)
   - CommerceTools: 0, Fluent: >0, NYCE: >0
   - CommerceTools not mirroring Fluent correctly
   - Action: Check CommerceTools sync process

3. **LAGERSYNKPROBLEM ELLER UTSÅLT** (Inventory sync problem or sold out)
   - CommerceTools: 0, Fluent: 0, NYCE: >0
   - Stock exists in warehouse but not digitally available
   - Action: Check if stock is marked as digitally sellable in NYCE

4. **EJ INLEVERAT?** (Not delivered?)
   - CommerceTools: 0, Fluent: 0, NYCE: 0
   - No stock in any system
   - Action: Check delivery status and inbound shipments

### NYCE-Specific Insights

When NYCE data is available (via API or CSV):

- **Staging Backlog**: High physical qty but low onHand (stock being put away)
- **Stopped Stock**: Items moved to inspection
- **Sync Variance**: Comparison between NYCE available (onHand - inOrder) and Fluent stock

### Simplified Spärr Detection (Skip Google Feed Mode)

When you skip Google Feed check (for items already known to be unavailable):

- **CT > 0 AND Fluent > 0** → TROLIGTVIS EN SPÄRR (strong indication of business logic block)
- **CT = 0 AND Fluent > 0** → TROLIGTVIS SYNKPROBLEM
- **CT = 0 AND Fluent = 0 AND NYCE > 0** → LAGERSYNKPROBLEM ELLER UTSÅLT
- **All systems = 0** → EJ INLEVERAT?

## NYCE CSV Format

If you need to use NYCE CSV mode (when API is unavailable from your location), export from NYCE or create a CSV with these columns:

```csv
SKU,Balance,InOrder
38454,1000,0
3849,500,10
3848,0,0
```

- **SKU**: Product PSID
- **Balance**: On-hand quantity (onHandQty)
- **InOrder**: In-order quantity (inOrderQty)

See `nycestockreport-example.csv` for reference.

## API Endpoints

- `POST /api/auth/login` - Authenticate with password
- `POST /api/auth/logout` - Logout
- `POST /api/stock-check` - Check stock levels for PSIDs

## Technology Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Deployment**: Vercel
- **CSV Parsing**: PapaParse
- **Authentication**: Cookie-based session

## File Structure

```
.
├── app/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/route.ts
│   │   │   └── logout/route.ts
│   │   └── stock-check/route.ts
│   ├── login/page.tsx
│   ├── page.tsx
│   └── layout.tsx
├── types/
│   └── index.ts
├── middleware.ts
├── package.json
├── tsconfig.json
├── next.config.js
└── vercel.json
```

## Security Notes

- Never commit `.env` file to version control
- Use strong passwords for `ACCESS_PASSWORD`
- All API credentials should be stored as environment variables
- Consider adding rate limiting for production use
- HTTPS is automatically enabled on Vercel

## Support

For issues or questions, contact the development team.
