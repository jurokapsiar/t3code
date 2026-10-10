import { Button, Card, CardFooter, CardHeader, Link } from "../../design-system/actions";
import { factoryPairUrl } from "../../factory/protocol";
import styles from "./FactoryAuthGate.module.css";

export interface FactoryAuthGateProps {
  readonly onRetry: () => void;
  readonly retrying?: boolean;
}

/** U2 renders this gate for unauthenticated state and owns the retry operation. */
export function FactoryAuthGate({ onRetry, retrying = false }: FactoryAuthGateProps) {
  const pairUrl = factoryPairUrl(
    window.location.origin,
    import.meta.env.DEV ? import.meta.env.DEV_FACTORY_PAIR_PORT : undefined,
  );

  return (
    <main className={styles.gate} aria-labelledby="factory-auth-title">
      <Card>
        <CardHeader header={<h1 id="factory-auth-title">Authorize this browser</h1>} />
        <p className={styles.description}>
          Open the factory pairing page. Authorize this browser there. Then return here and retry.
        </p>
        <CardFooter>
          <div className={styles.actions}>
            <Link href={pairUrl} target="_blank" rel="noopener noreferrer">
              Authorize this browser
            </Link>
            <Button appearance="primary" onClick={onRetry} disabled={retrying}>
              {retrying ? "Checking authorization" : "Retry"}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </main>
  );
}
