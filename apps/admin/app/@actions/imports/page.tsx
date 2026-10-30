import Link from 'next/link';
import { PageActions } from '@/components/shell/PageActions';

export default function ImportsActions() {
  return (
    <PageActions path="/imports">
      <Link href="/imports/new" className="btn btn-primary">
        New import
      </Link>
    </PageActions>
  );
}
