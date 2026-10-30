import { handleApiRequest } from '@/lib/api-server/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (req: Request) => handleApiRequest(req, '/health');
