# Urban Naari Order Tracker

Internal dashboard for tracking Urban Naari Shopify orders via DTDC courier. Pulls fulfilled orders from Shopify, fetches live tracking from DTDC, stores everything in Notion, and displays it in a dark-themed Command Center dashboard.

## Features

- **Shopify sync** — pulls all fulfilled orders with tracking numbers
- **DTDC tracking** — fetches live status, milestones, and delivery timeline
- **Notion storage** — all data stored in the cloud, accessible from any device
- **Command Center dashboard** — dark theme with Orders, Influencer, Abandoned Checkouts, and Analytics tabs
- **Auto-refresh** — polls DTDC every 30 minutes for non-delivered orders
- **COD tracking** — pending amount display, collection toggle, and Shopify mark-as-paid sync
- **Shipping charge tracking** — per-order "Shipping Paid" toggle (orders + influencer) with a dashboard "Shipping Pending" widget summing unpaid courier charges
- **WhatsApp automation** — auto-send messages for COD confirmation, fulfilment + tracking, RTO follow-ups, and abandoned-checkout recovery (paired with a Chrome extension that auto-clicks Send)
- **Abandoned checkouts** — list, message, and track recovery attempts; supports image-grid clipboard for product photos
- **Delivery emails** — manually triggered delivery confirmation emails via SMTP
- **Influencer shipments** — separate tracking, product checklist, video-received workflow, Jaipur in-person flow
- **Analytics** — delivery rate, RTO rate, stuck orders, COD collection %, top destinations

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A Shopify store with a custom app (Client ID + Secret)
- A [Notion integration](https://www.notion.so/my-integrations) with a shared page

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create `.env.local` in the project root:

```
# Shopify
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_CLIENT_ID=your_client_id
SHOPIFY_CLIENT_SECRET=your_client_secret
NEXT_PUBLIC_SHOPIFY_STORE_URL=your-store.myshopify.com

# Notion
NOTION_API_KEY=your_notion_api_key
NOTION_PAGE_ID=your_notion_page_id

# SMTP (for delivery emails)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email
SMTP_PASS=your_password
SMTP_FROM=your_from_address

# Email Test Mode (redirects all emails to your inbox instead of customers)
EMAIL_TEST_MODE=true
EMAIL_TEST_RECIPIENT=your_test_email@example.com
```

### 3. Set up Notion database

Run once to create the database in your Notion page:

```bash
npx tsx src/lib/notion-setup.ts
```

### 4. Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

<!-- AUTO-GENERATED:scripts (sourced from package.json) -->

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the Next.js development server with hot reload |
| `npm run build` | Production build (Next.js compile + type check) |
| `npm start` | Run the production build (after `npm run build`) |
| `npm run lint` | Run ESLint over the project |
| `npx tsx src/lib/notion-setup.ts` | One-time: create the Orders database in your Notion page |
| `npx tsc --noEmit` | Run a TypeScript type check without emitting files |

<!-- /AUTO-GENERATED:scripts -->

## Usage

1. **Sync Orders** — pulls latest fulfilled orders from Shopify into Notion
2. **Refresh Tracking** — fetches DTDC tracking status for all active orders
3. **Click any row** — expands to show full tracking timeline and actions
4. **Search** — filter by order number, customer name, tracking number, or city
5. **Status filter** — show only orders with a specific delivery status
6. **COD toggle** — mark COD orders as collected in the expanded row
7. **Mark RTO** — flag returned orders and add RTO tracking numbers
8. **RTO Received** — confirm RTO product received back at warehouse
9. **Initiate Return** — start a return for delivered orders
10. **Mark Return Complete** — confirm returned product received back
11. **Send Email** — manually send delivery confirmation to customer

## API Routes

<!-- AUTO-GENERATED:api-routes (sourced from src/app/api/**/route.ts) -->

### Orders

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/orders` | GET | List orders with `status`, `search`, `shippingMode`, `hideDelivered` filters |
| `/api/orders/[id]/status` | PATCH | Update delivery status |
| `/api/orders/[id]/cod-status` | PATCH | Toggle COD collection (also marks Shopify as paid on Collected) |
| `/api/orders/[id]/shipping-paid` | PATCH | Toggle "Shipping charge paid to courier" flag |
| `/api/orders/[id]/shipping-mode` | PATCH | Set Air or Road shipping mode |
| `/api/orders/[id]/weight` | PATCH | Save package weight (drives shipping-charge calculation) |
| `/api/orders/[id]/rto-tracking` | PATCH | Save the return AWB for an RTO |
| `/api/orders/[id]/assign-tracking` | POST | Attach a DTDC tracking number to an unfulfilled order (creates Shopify fulfillment) |
| `/api/orders/[id]/refresh` | POST | Re-pull DTDC tracking for a single order |
| `/api/orders/[id]/cancel` | POST | Cancel order in Notion + Shopify |
| `/api/orders/[id]/line-items` | GET | Fetch Shopify line items for an order |
| `/api/orders/[id]/whatsapp-status` | POST/PATCH/PUT | Mark COD-confirmation WA sent, update confirmation, record follow-up |
| `/api/orders/[id]/rto-whatsapp-status` | POST/PATCH/PUT | Mark RTO WA sent, update reachability, record follow-up |

### Tracking + Shopify

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/tracking/refresh` | POST | Bulk refresh DTDC tracking for every active order |
| `/api/shopify/sync` | POST | Pull fulfilled + unfulfilled orders from Shopify into Notion |
| `/api/shopify/abandoned-checkouts` | GET | Pull abandoned checkouts from Shopify |

### Email

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/email/delivery` | POST | Send delivery-confirmation email to customer |
| `/api/email/review` | POST | Send post-delivery review-request email |
| `/api/email/preview` | GET | Preview delivery email HTML in the browser (`?orderId=`) |

### Influencer Shipments

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/influencer` | GET/POST | List or create influencer shipments |
| `/api/influencer/refresh` | POST | Refresh DTDC tracking for all active influencer shipments (skips Video Received / Completed so manual progress isn't overwritten) |
| `/api/influencer/product-lookup` | POST | Resolve a Shopify product handle for the product checklist |
| `/api/influencer/[id]/tracking` | PUT | Set/update the influencer shipment tracking number |
| `/api/influencer/[id]/products` | GET/PUT | Read or update the influencer product checklist |
| `/api/influencer/[id]/status` | PUT | Update influencer delivery status (e.g. Video Received, Completed) |
| `/api/influencer/[id]/mark-delivered` | POST | Mark a Jaipur (in-person) shipment as delivered |
| `/api/influencer/[id]/shipping-paid` | PATCH | Toggle "Shipping charge paid to courier" for influencer |

### Abandoned Checkouts

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/abandoned-checkouts/[id]/wa-sent` | POST | Mark abandoned-checkout WA recovery sent |
| `/api/abandoned-checkouts/item-images` | POST | Build a product-image grid for clipboard paste into WhatsApp |

<!-- /AUTO-GENERATED:api-routes -->

## Key Behaviors

- **Order sorting**: Orders are sorted by Shopify Order ID in descending order to display them in proper sequential order
- **Order filter**: Orders #1025 and below are hidden (initial test orders)
- **Auto-refresh**: Tracking refreshes every 30 minutes
- **Delayed flag**: Orders in transit for 7+ days are highlighted in red
- **Return window**: 48-hour return window tracked after delivery
- **Delivery emails**: Branded template (coral palette matching website), manually triggered, with browser preview at `/api/email/preview?orderId=`
- **Email test mode**: Set `EMAIL_TEST_MODE=true` to redirect all emails to `EMAIL_TEST_RECIPIENT` instead of customers
- **Status mapping**: DTDC statuses map to 17 internal states (`src/lib/data/types.ts`): Unfulfilled, Booked, Picked Up, In Transit, At Destination, Out for Delivery, Delivered, Undelivered, RTO, RTO Confirmed, RTO Received, Return Initiated, Return Complete, Video Received, Product Received Back, Completed, Cancelled
- **RTO flow** (3-stage, all manual transitions): RTO → RTO Confirmed (after operator reaches customer) → RTO Received (when product arrives back at warehouse). DTDC RTO-prefix events do not auto-advance status.
- **Return flow**: Delivered → Initiate Return → Mark Return Complete (when product arrives back)
- **Cancelled orders**: hidden everywhere in the dashboard (cancel still writes to Notion + Shopify, just no row is rendered). Verify in Shopify admin.
- **Return Complete**: hidden from main list; appears only when "Show Delivered" is toggled on.
- **Status guard**: `src/lib/status-machine.ts` blocks invalid auto-transitions (e.g. RTO→Delivered) during DTDC refresh; manual transitions always allowed.
- **Influencer terminal statuses**: `Video Received` and `Completed` are set manually after delivery and represent post-DTDC workflow state. `/api/influencer/refresh` skips shipments in these statuses entirely (no DTDC call, no Notion write), so refresh-tracking can never roll them back to `Delivered`.

## Tech Stack

- Next.js 16.2.1 (App Router, TypeScript)
- React 19
- Tailwind CSS 4 + shadcn/ui (add components via `npx shadcn@latest add <component>`)
- Notion API (cloud data store)
- DTDC Tracking API
- Nodemailer (SMTP)

## Project Structure

<!-- AUTO-GENERATED:project-structure (sourced from src/) -->

```
src/
  app/
    page.tsx                  # Main dashboard (Orders / Influencer / Abandoned / Analytics tabs)
    api/                      # API routes (see "API Routes" section)
  components/
    InfluencerSection.tsx     # Influencer tab
    AbandonedCheckoutsSection.tsx # Abandoned-checkout WA recovery flow
    TrackingTimeline.tsx      # Tracking event timeline
    StatusBadge.tsx           # Color-coded status badges
    WeightInput.tsx           # Weight input + calculated shipping charge badge
    ShippingExportDialog.tsx  # Excel export of shipping charges
    ui/                       # shadcn/ui components
  lib/
    dtdc.ts                   # DTDC API integration & status mapping
    shopify.ts                # Shopify Admin API client (sync, fulfillments, mark-paid, inventory)
    email.ts                  # SMTP email templates
    shipping.ts               # Shipping rate slabs + calculateShippingCharge()
    status-machine.ts         # Allowed transitions + DTDC-driven status resolver
    data/
      types.ts                # TypeScript interfaces (Order, InfluencerShipment, etc.)
      notion.ts               # Notion database CRUD + lazy schema migrations
      index.ts                # Data provider export
whatsapp-autosend-extension/  # Chrome extension that auto-clicks WA Web Send on /send?text= links
scripts/                      # One-off debug/migration scripts (e.g. debug-checkout.ts)
```

<!-- /AUTO-GENERATED:project-structure -->

## Shopify App Setup

1. Go to Shopify Admin > Settings > Apps and sales channels > Develop apps
2. Create a custom app
3. Add scopes: `read_orders`, `read_all_orders`, `write_orders`, `write_fulfillments`, `write_merchant_managed_fulfillment_orders`, `write_inventory`

   The app writes as well as reads: it creates fulfillments with DTDC tracking,
   posts fulfillment events (out for delivery / delivered), captures COD
   payments, cancels orders, and adjusts inventory for influencer shipments.
4. Install the app
5. Use the Client ID and Client Secret in `.env.local`

## Notion Setup

1. Go to https://www.notion.so/my-integrations
2. Create a new integration, copy the API key
3. Create a blank Notion page
4. Share the page with your integration (click Share > invite the integration)
5. Copy the page ID from the URL (the 32-character hex string after the page title)
