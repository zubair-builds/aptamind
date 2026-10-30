import Link from 'next/link';
import { PageActions } from '@/components/shell/PageActions';

export default function SourcesActions() {
  return (
    <PageActions path="/sources">
      <Link href="/sources/new" className="btn btn-primary">
        New source
      </Link>
    </PageActions>
  );
}
