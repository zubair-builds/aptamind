import Link from 'next/link';
import { PageHeader } from '@/components/Section';
import WorkflowCanvas from '@/components/canvas/WorkflowCanvas';

export const metadata = { title: 'Workflow Canvas' };

export default function CanvasPage() {
  return (
    <>
      <PageHeader
        title="Workflow Canvas"
        subtitle="Visually compose Connect → Understand → Enrich → Act pipelines. Sources can be MCP, HTTP, CSV, browser, file, registry, or other."
      />
      <div style={{ marginBottom: 12 }}>
        <Link href="/workflows" className="small">
          ← Back to Workflows
        </Link>
      </div>
      <WorkflowCanvas />
    </>
  );
}
