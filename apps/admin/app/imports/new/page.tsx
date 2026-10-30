import Link from 'next/link';
import s from '@/components/imports/imports.module.css';
import { PageHeader } from '@/components/Section';
import { Icon } from '@/components/ui/Icon';

export const metadata = { title: 'New import' };

const TYPES = [
  {
    href: '/imports/new/companies',
    title: 'Companies',
    text: 'A CSV of companies: names, domains, countries, register ids. You choose which columns to import.',
  },
  {
    href: '/imports/new/ats-boards',
    title: 'Known ATS boards',
    text: 'A CSV of Greenhouse, Ashby or Lever boards with their company. Each board becomes a job source.',
  },
  {
    href: '/imports/new/snapshot',
    title: 'Source snapshot',
    text: 'Any file a source accepts, sent as it is. The source’s own workflow processes it.',
  },
];

export default function NewImportPage() {
  return (
    <>
      <PageHeader title="New import" subtitle="Choose what the file contains." />
      <ul className={s.types}>
        {TYPES.map((t) => (
          <li key={t.href}>
            <Link href={t.href} className={s.type}>
              <span className={s.typeTitle}>
                <Icon name="upload" /> {t.title}
              </span>
              <span className={s.typeText}>{t.text}</span>
            </Link>
          </li>
        ))}
        <li>
          <div className={`${s.type} ${s.typeDisabled}`} aria-disabled="true">
            <span className={s.typeTitle}>
              Jobs / job URLs <span className={s.soon}>Coming soon</span>
            </span>
            <span className={s.typeText}>A list of job links or a jobs CSV. Not available yet.</span>
          </div>
        </li>
      </ul>
    </>
  );
}
