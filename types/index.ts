export interface GoogleFeedProduct {
  id: string
  availability: 'in_stock' | 'out_of_stock'
}

export interface AutocompleteProduct {
  productName: string
  url: string
  sku: string
  variant: {
    sku: string
    inventoryQuantity: number
  }
}

export interface AutocompleteResponse {
  products: AutocompleteProduct[]
}

export interface FluentInventoryNode {
  productRef: string
  locationRef: string
  onHand: number
}

export interface NyceArticle {
  articleId: string
  unitOfMeasureArticleStockBalance: string
  updatedAt: string
  articleLocationId1: string | null
  articleLocationId2: string | null
  physicalQty: number
  onHandQty: number
  inOrderQty: number
  allocatedQty: number
  stoppedQty: number
  availableQty: number | null
  reservedQty: number | null
  digitalSellableQty: number | null
}

export interface NyceResponse {
  dataProduct: any
  generatedAt: string
  warehouse: string
  storeId: string
  articles: NyceArticle[]
}

export interface NyceCsvData {
  [psid: string]: {
    balance: number
    inOrder: number
  }
}

export interface StockCheckRequest {
  psids: string[]
  skipGoogleFeed?: boolean
  nyceCsvData?: NyceCsvData
  skipNyce?: boolean
}

export interface ProductStockResult {
  psid: string
  productName: string
  googleSellable: boolean | null
  commerceToolsStock: number
  fluentStock: number
  nyceStock: NyceArticle | null
  status: 'ok' | 'issue'
  analysis: string
  details: string[]
}

export interface StockCheckResponse {
  results: ProductStockResult[]
  errors: string[]
}
