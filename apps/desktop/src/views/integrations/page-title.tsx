// The heading of an integrations sub-page (connect, install, sources).

export function PageTitle({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {description && <p className="mt-2 max-w-prose text-sm text-muted-foreground">{description}</p>}
    </header>
  );
}
