export type CreatorsMoney = {
  amount?: number;
  currency?: string;
  displayAmount?: string;
};

export type CreatorsListing = {
  availability?: { type?: string; message?: string; minOrderQuantity?: number; maxOrderQuantity?: number };
  condition?: { value?: string; subCondition?: string; conditionNote?: string };
  dealDetails?: {
    accessType?: string;
    badge?: string;
    earlyAccessDurationInMilliseconds?: number;
    endTime?: string;
    percentClaimed?: number;
    startTime?: string;
  };
  isBuyBoxWinner?: boolean;
  merchantInfo?: { id?: string; name?: string };
  price?: {
    money?: CreatorsMoney;
    pricePerUnit?: CreatorsMoney;
    savingBasis?: { money?: CreatorsMoney; savingBasisType?: string; savingBasisTypeLabel?: string };
    savings?: { money?: CreatorsMoney; percentage?: number };
  };
  type?: string;
  violatesMAP?: boolean;
};

export type CreatorsItem = {
  asin?: string;
  parentASIN?: string;
  detailPageURL?: string;
  itemInfo?: { title?: { displayValue?: string; label?: string; locale?: string } };
  images?: { primary?: { large?: { url?: string; width?: number; height?: number } } };
  offersV2?: { listings?: CreatorsListing[] };
};

export type CreatorsApiError = {
  code?: string;
  type?: string;
  message?: string;
  reason?: string;
  retryAfterSeconds?: number;
  resourceType?: string;
  resourceId?: string;
};

export type GetItemsResponse = {
  itemsResult?: { items?: CreatorsItem[] };
  itemResults?: { items?: CreatorsItem[] };
  errors?: CreatorsApiError[];
};

export const AMAZON_CREATORS_RESOURCES = [
  "itemInfo.title",
  "images.primary.large",
  "offersV2.listings.price",
  "offersV2.listings.availability",
  "offersV2.listings.condition",
  "offersV2.listings.dealDetails",
  "offersV2.listings.isBuyBoxWinner",
  "offersV2.listings.merchantInfo",
  "offersV2.listings.type",
  "parentASIN"
] as const;
