export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SECRET_KEY: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_DEFAULT_MODEL: string;
  AI_COMPLEX_MODEL: string;
  ADMIN_EMAIL?: string;
  ADMIN_INITIAL_PASSWORD?: string;
  APP_TIMEZONE: string;
  MAX_UPLOAD_BYTES: string;
  PDF_EXPORT_MODE: "downgraded";
};
