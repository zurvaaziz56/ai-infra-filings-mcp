import { SourceError } from './errors.js';
import { HttpSource, type HttpSourceOptions } from './http.js';

export interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface SecFact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy?: number | null;
  fp?: string | null;
  form: string;
  filed: string;
  frame?: string;
}

export interface CompanyFacts {
  // A number for most filers, but a zero-padded string for some, such as CoreWeave.
  cik: number | string;
  entityName: string;
  facts: Record<string, Record<string, { units: Record<string, SecFact[]> }>>;
}

export interface Submissions {
  cik: string;
  name: string;
  tickers: string[];
  sicDescription?: string;
  fiscalYearEnd?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
}

export interface SearchHit {
  _id: string;
  _source: {
    ciks: string[];
    display_names: string[];
    form: string;
    file_date: string;
    period_ending?: string | null;
    adsh: string;
  };
}

export interface SearchResponse {
  hits: { total: { value: number }; hits: SearchHit[] };
}

export interface SearchParams {
  query: string;
  forms?: string[];
  from?: string;
  to?: string;
  offset?: number;
}

export interface SecClientOptions extends HttpSourceOptions {
  userAgent: string | undefined;
}

const USER_AGENT_HELP =
  'Set SEC_USER_AGENT to your name and email, for example "Jane Doe jane@example.com". The SEC rejects requests without a contact email.';

export class SecClient {
  readonly http: HttpSource;

  constructor(private readonly options: SecClientOptions) {
    // 8 requests a second keeps under the SEC's limit of 10.
    this.http = new HttpSource('sec', 'the SEC', { ...options, defaultRate: 8 });
  }

  get breaker() {
    return this.http.breaker;
  }

  get budget() {
    return this.http.budget;
  }

  get userAgentConfigured(): boolean {
    return isValidUserAgent(this.options.userAgent);
  }

  tickers(): Promise<Record<string, TickerRow>> {
    return this.getJson('https://www.sec.gov/files/company_tickers.json');
  }

  submissions(cik: string): Promise<Submissions> {
    return this.getJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  }

  companyFacts(cik: string): Promise<CompanyFacts> {
    return this.getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  }

  searchFilings(params: SearchParams): Promise<SearchResponse> {
    const url = new URL('https://efts.sec.gov/LATEST/search-index');
    url.searchParams.set('q', params.query);
    if (params.forms?.length) url.searchParams.set('forms', params.forms.join(','));
    if (params.from || params.to) {
      url.searchParams.set('dateRange', 'custom');
      if (params.from) url.searchParams.set('startdt', params.from);
      if (params.to) url.searchParams.set('enddt', params.to);
    }
    if (params.offset) url.searchParams.set('from', String(params.offset));
    return this.getJson(url.toString());
  }

  async getJson<T>(url: string): Promise<T> {
    const userAgent = this.options.userAgent;
    if (!isValidUserAgent(userAgent)) {
      throw new SourceError('config', `SEC_USER_AGENT is missing or has no email. ${USER_AGENT_HELP}`);
    }
    const response = await this.http.send(url, { headers: { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate' } });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 404) throw new SourceError('not_found', 'The SEC has no data at this address.');
    if (response.status === 403) throw new SourceError('forbidden', `The SEC refused the request (403). ${USER_AGENT_HELP}`);
    throw new SourceError('unavailable', `The SEC returned an error (${response.status}).`);
  }
}

function isValidUserAgent(value: string | undefined): value is string {
  return !!value && /\S+@\S+\.\S+/.test(value);
}

export function padCik(cik: string | number): string {
  return String(cik).padStart(10, '0');
}
