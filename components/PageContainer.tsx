/**
 * The centred column every page outside a classroom renders into, plus the
 * subtle background the root layout used to paint.
 *
 * It stopped living in the root layout when the classroom shell arrived: those
 * bands span the viewport, and a container above them would have boxed them in.
 */
export function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="color-bg-subtle" style={{ minHeight: 'calc(100vh - 64px)' }}>
      <div className="container-lg p-responsive py-4">{children}</div>
    </div>
  )
}
