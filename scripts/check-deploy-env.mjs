for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "VITE_API_BASE_URL", "VITE_BOT_BASE_URL", "PAGES_URL"]) {
  if (!process.env[name]?.trim()) throw new Error(`Set ${name} in the repository deployment settings.`);
}
for (const name of ["VITE_API_BASE_URL", "VITE_BOT_BASE_URL", "PAGES_URL"]) {
  const url = new URL(process.env[name]);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`${name} must be a public HTTPS URL without credentials, query or fragment.`);
}
console.log("Deployment settings are present. No secret values printed.");
