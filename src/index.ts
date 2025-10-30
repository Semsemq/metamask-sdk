import { getSandbox, proxyToSandbox, parseSSEStream, type Sandbox, type ExecEvent } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  GITHUB_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    if (request.method !== 'POST') {
      return new Response('POST { "repoUrl": "https://github.com/owner/repo", "branch": "main" }');
    }

    try {
      const { repoUrl, branch } = await request.json();

      if (!repoUrl) {
        return Response.json({ error: 'repoUrl required' }, { status: 400 });
      }

      const sandbox = getSandbox(env.Sandbox, `test-${Date.now()}`);

      try {
        // Clone repository
        console.log('Cloning repository...');
        let cloneUrl = repoUrl;

        if (env.GITHUB_TOKEN && cloneUrl.includes('github.com')) {
          cloneUrl = cloneUrl.replace('https://', `https://${env.GITHUB_TOKEN}@`);
        }

        await sandbox.gitCheckout(cloneUrl, {
          ...(branch && { branch }),
          depth: 1,
          targetDir: 'repo'
        });
        console.log('Repository cloned');

        // Detect project type
        const projectType = await detectProjectType(sandbox);
        console.log(`Detected ${projectType} project`);

        // Install dependencies
        const installCmd = getInstallCommand(projectType);
        if (installCmd) {
          console.log('Installing dependencies...');
          const installStream = await sandbox.execStream(`cd /workspace/repo && ${installCmd}`);

          let installExitCode = 0;
          for await (const event of parseSSEStream<ExecEvent>(installStream)) {
            if (event.type === 'stdout' || event.type === 'stderr') {
              console.log(event.data);
            } else if (event.type === 'complete') {
              installExitCode = event.exitCode;
            }
          }

          if (installExitCode !== 0) {
            return Response.json({
              success: false,
              error: 'Install failed',
              exitCode: installExitCode
            });
          }
          console.log('Dependencies installed');
        }

        // Run tests
        console.log('Running tests...');
        const testCmd = getTestCommand(projectType);
        const testStream = await sandbox.execStream(`cd /workspace/repo && ${testCmd}`);

        let testExitCode = 0;
        for await (const event of parseSSEStream<ExecEvent>(testStream)) {
          if (event.type === 'stdout' || event.type === 'stderr') {
            console.log(event.data);
          } else if (event.type === 'complete') {
            testExitCode = event.exitCode;
          }
        }
        console.log(`Tests completed with exit code ${testExitCode}`);

        return Response.json({
          success: testExitCode === 0,
          exitCode: testExitCode,
          projectType,
          message: testExitCode === 0 ? 'All tests passed' : 'Tests failed'
        });

      } finally {
        await sandbox.destroy();
      }

    } catch (error: any) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  },
};

async function detectProjectType(sandbox: any): Promise<string> {
  try {
    await sandbox.readFile('/workspace/repo/package.json');
    return 'nodejs';
  } catch {}

  try {
    await sandbox.readFile('/workspace/repo/requirements.txt');
    return 'python';
  } catch {}

  try {
    await sandbox.readFile('/workspace/repo/go.mod');
    return 'go';
  } catch {}

  return 'unknown';
}

function getInstallCommand(projectType: string): string {
  switch (projectType) {
    case 'nodejs': return 'npm install';
    case 'python': return 'pip install -r requirements.txt || pip install -e .';
    case 'go': return 'go mod download';
    default: return '';
  }
}

function getTestCommand(projectType: string): string {
  switch (projectType) {
    case 'nodejs': return 'npm test';
    case 'python': return 'python -m pytest || python -m unittest discover';
    case 'go': return 'go test ./...';
    default: return 'echo "Unknown project type"';
  }
}
