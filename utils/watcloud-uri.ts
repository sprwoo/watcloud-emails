const RESOLVER_URL_PREFIXES = [
    "https://rgw.watonomous.ca/asset-perm",
    "https://rgw.watonomous.ca/asset-off-perm",
    "https://rgw.watonomous.ca/asset-temp",
]

function extractSha256(str: string) {
    const sha256Match = str.match(/sha256:([a-f0-9]{64})/);
    if (!sha256Match) {
        throw new Error("Invalid string: does not contain a SHA-256 hash.");
    }
    return sha256Match[1];
}

// A cache for resolved assets
const assetCache = new Map<string, string>();

export class WATcloudURI extends URL {
    sha256: string;
    name: string | null = null;

    constructor(uri: string) {
        super(uri);
        if (this.protocol !== "watcloud:") {
            throw new Error("Invalid WATcloud URI: protocol must be 'watcloud:'");
        }
        if (this.hostname !== "v1") {
            throw new Error(`Invalid WATcloud URI: unsupport version "${this.hostname}". Only 'v1' is supported`);
        }
        this.sha256 = extractSha256(this.pathname);
        if (this.searchParams.has("name")) {
            this.name = this.searchParams.get("name");
        }
    }

    async resolveToURL() {
        const cached = assetCache.get(this.sha256);
        if (cached) {
            return cached;
        }

        const urls = await Promise.all(RESOLVER_URL_PREFIXES.map(async (prefix) => {
            const r = `${prefix}/${this.sha256}`;
            const res = await fetch(r, { method: 'HEAD' });
            if (res.ok) {
                return r;
            }
        }));

        const url = urls.find((url) => url !== undefined);
        if (!url) {
            throw new Error(`Asset ${this.sha256} not found in the asset store.`);
        }

        assetCache.set(this.sha256, url);

        return url
    }

    resolveFromCache() {
        let ret = assetCache.get(this.sha256);
        if (!ret) {
            // If we are in development mode, serve the asset using the dev server
            if (process.env.NODE_ENV === "development") {
                const fs = require('fs');
                const path = require('path');
                const { Readable } = require('stream');

                const staticCachePath = path.resolve(__dirname, "../emails/static/cache");
                const filename = this.sha256;
                const filepath = path.join(staticCachePath, filename);

                if (!fs.existsSync(filepath)) {
                    if (!fs.existsSync(staticCachePath)) {
                        fs.mkdirSync(staticCachePath, { recursive: true });
                    }
                    this.resolveToURL().then((url) => {
                        fetch(url).then((res) => {
                            const dest = fs.createWriteStream(filepath);
                            if (res.body) {
                                Readable.from(res.body).pipe(dest);
                            }
                        })
                    })
                }

                ret = `${process.env.CDN_URL || ""}/static/cache/${filename}`;
            } else {
                throw new Error(`Asset ${this.sha256} not found in the cache.`);
            }
        }

        return ret
    }

    equals(other: WATcloudURI) {
        return this.toString() === other.toString();
    }
}

// Resolve all assets. This can also be used to prewarm the cache.
export function resolveAll(assets: WATcloudURI[]) {
    return Promise.all(assets.map((asset) => asset.resolveToURL()));
}

// MARK: Asset registration
// This section contains code for the asset registration system.
// This system allows for assets to be resolved synchronously.
// Usage:
// 1. Register assets using `registerAsset(name, uri)`.
// 2. Wait for all assets to resolve using `await waitForAssets()`.
// 3. Get an asset using `getAsset(name)`.

const assets = new Map<string, WATcloudURI>();
const assetResolverPromises = new Map<string, Promise<string>>();

// Register an asset with a name and a URI. This will also start resolving the asset.
// To wait for all assets to resolve, `await waitForAssets()` after all assets have been registered.
export function registerAsset(name: string, uri: WATcloudURI) {
    if (assets.has(name)) {
        const asset = assets.get(name)!;
        if (asset.equals(uri)) {
            // already registered
            return;
        } else {
            throw new Error(`Asset ${name} is already registered with a different URI (${!asset.toString()}). Cannot add asset with URI ${uri.toString()}.`);
        }
    }
    assets.set(name, uri);
    assetResolverPromises.set(name, uri.resolveToURL());
}

export function getAsset(name: string) {
    if (!assets.has(name)) {
        throw new Error(`Asset ${name} is not registered.`);
    }
    return assets.get(name)!;
}

export function waitForAssets() {
    return Promise.all(assetResolverPromises.values());
}
