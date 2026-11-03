# Stray Fund

Community funding for neighbourhood stray cat care. Built for a PayPal hackathon.

## Local setup

1. Install Postgres 17 and create two databases: `strayfund_dev` and `strayfund_test`.
2. Copy `.env.example` to `.env.local` and fill in `DATABASE_URL` and `TEST_DATABASE_URL`.
3. `npm install`
4. `npm run dev`, then check `http://localhost:3000/api/health`.

## Scripts

- `npm run dev` start the dev server
- `npm test` run the tests (needs `TEST_DATABASE_URL`)
- `npm run build` production build
- `npm run lint` lint

## License

MIT
