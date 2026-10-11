# Esegue un comando in uno pseudo-terminale (stdin/stdout sono un TTY) e ne riporta output e codice d'uscita.
# Usato dai test per simulare l'esecuzione da un terminale interattivo (come il doppio clic).
import os
import pty
import sys

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
